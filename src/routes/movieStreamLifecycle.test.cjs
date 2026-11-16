const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { createRequire } = require('node:module');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { createPlaybackLogging } = require('../utils/playbackLogging.cjs');
const { createHlsUpstreamDiagnostics } = require('../utils/hlsUpstreamDiagnostics.cjs');

async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Missing lifecycle record');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('local native HTTP proxy distinguishes completion, source truncation, deadlines and client disconnects', async t => {
  const logs = [], received = [];
  let allowed = true, pin = 'PRIVATE-PIN', backpressured = false;
  const logger = { log: (_tag, json) => logs.push(JSON.parse(json)), warn: (_tag, json) => logs.push(JSON.parse(json)) };
  const logging = createPlaybackLogging({ logger, secret: 'fixture-log-key' });
  const upstream = await listen(t, http.createServer((req, res) => {
    received.push(req.url);
    if (req.url.startsWith('/headers')) return;
    res.on('error', () => {});
    const mode = req.url.split('?')[0];
    if (mode === '/normal') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4/5', 'Content-Length': '5' });
      res.end('video'); return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '100000000' });
    res.write('video');
    if (mode === '/reset') {
      const timer = setTimeout(() => res.destroy(), 25);
      res.once('close', () => clearTimeout(timer));
    }
    if (mode === '/pressure') {
      const chunk = Buffer.alloc(65536);
      const pump = () => {
        while (!res.destroyed) {
          if (!res.write(chunk)) { backpressured = true; break; }
        }
      };
      res.on('drain', pump); pump();
    }
  }));
  const filename = require.resolve('./movieStream.routes.cjs'), routeRequire = createRequire(filename);
  // Production validation still runs; only the transport and test clock are remapped.
  const transport = { request(url, options, callback) {
    const request = http.request(new URL(url.pathname + url.search, upstream), {
      method: options.method, headers: options.headers, signal: options.signal, agent: false,
    }, callback);
    const nativeTimeout = request.setTimeout.bind(request);
    request.setTimeout = (ms, handler) => nativeTimeout(ms === 0 ? 0 : 120, handler);
    return request;
  } };
  const context = vm.createContext({ module: { exports: {} }, Buffer, URL, AbortController,
    process: { env: { JWT_SECRET: 'fixture-ticket-key' } },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 30000 ? 500 : ms), clearTimeout,
    require(id) {
      if (id === 'node:http' || id === 'node:https') return transport;
      if (id === 'node:dns/promises') return { lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
      if (id === '../utils/playbackLogging.cjs') return { playbackLogging: logging };
      if (id === '../utils/hlsUpstreamDiagnostics.cjs') return { createHlsUpstreamDiagnostics: options => createHlsUpstreamDiagnostics({ ...options, logger, logging }) };
      if (id === '../utils/movieBodyTimeout.cjs') return { watchMovieBody: (up, down, options) =>
        routeRequire(id).watchMovieBody(up, down, { ...options, idleMs: 120, stallMs: 500 }) };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ anime_enabled: allowed, adult_enabled: allowed }) };
      if (id === '../utils/adultAccess.cjs') return { readAdultPin: async () => ({ fingerprint: pin }) };
      return routeRequire(id);
    },
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const app = express(); app.use(context.module.exports);
  const api = await listen(t, http.createServer(app));
  const tickets = createPlaybackTickets('fixture-ticket-key');
  const url = (mode, section = 'anime') => `${api}/movies/stream/${tickets.issue(
    `https://cdn.example/${mode}?token=PRIVATE-CREDENTIAL`, 'PRIVATE-DEVICE', section,
    section === 'adult' ? 'PRIVATE-PIN' : undefined)}`;
  const records = () => logs.filter(row => row.event === 'stream_lifecycle');
  async function capture(mode, action) {
    const count = records().length;
    await action(url(mode));
    await waitFor(() => records().length > count);
    return records().at(-1);
  }
  const events = row => row.events.map(item => item.event);
  await t.test('valid range completes with exact bytes and no timeout marker', async () => {
    const row = await capture('normal', async link => {
      const result = await fetch(link, { headers: { Range: 'bytes=0-4' } });
      assert.equal(result.status, 206);
      assert.equal(result.headers.get('content-range'), 'bytes 0-4/5');
      assert.equal(await result.text(), 'video');
    });
    assert.equal(row.upstream_bytes_consumed, 5);
    assert.equal(row.upstream_complete, true); assert.equal(row.downstream_finished, true);
    assert.ok(events(row).includes('upstream_end'));
    assert.ok(!events(row).includes('socket_timeout'));
  });
  await t.test('source truncation is observed before proxy cleanup', async () => {
    const row = await capture('reset', async link => {
      const result = await fetch(link);
      await assert.rejects(result.arrayBuffer());
    });
    assert.equal(row.upstream_complete, false);
    assert.equal(row.upstream_bytes_consumed, 5);
    assert.ok(events(row).indexOf('upstream_aborted') < events(row).indexOf('proxy_cleanup'));
    assert.ok(!events(row).includes('socket_timeout'));
  });
  await t.test('stalled body records its independent upstream idle timeout', async () => {
    const row = await capture('stall', async link => {
      const result = await fetch(link); await assert.rejects(result.arrayBuffer());
    });
    assert.equal(events(row)[1], 'upstream_idle_timeout');
    assert.equal(row.upstream_complete, false);
  });
  await t.test('initial deadline has a separate marker from socket timeout', async () => {
    // Delay authorization to exercise the overall deadline independently of sockets.
    const delayedContext = vm.createContext({ ...context, module: { exports: {} },
      require: id => id === '../utils/movieSettings.cjs'
        ? { readMovieSettings: async () => { await new Promise(resolve => setTimeout(resolve, 550)); return { anime_enabled: true }; } }
        : context.require(id) });
    // A fresh route captures the delayed settings dependency without changing production.
    vm.runInContext(fs.readFileSync(filename, 'utf8'), delayedContext, { filename });
    const delayedApp = express(); delayedApp.use(delayedContext.module.exports);
    const delayedApi = await listen(t, http.createServer(delayedApp));
    const row = await capture('normal', async link => {
      const result = await fetch(link.replace(api, delayedApi)); assert.equal(result.status, 502); await result.text();
    });
    assert.ok(events(row).includes('headers_deadline'));
    assert.ok(!events(row).includes('socket_timeout'));
  });
  for (const mode of ['cancel', 'pressure']) {
    await t.test(`${mode}: downstream disconnect precedes proxy cleanup`, async () => {
      const row = await capture(mode, link => new Promise((resolve, reject) => {
        const request = http.get(link, response => {
          response.on('error', () => {});
          response.pause();
          setTimeout(() => { response.destroy(); resolve(); }, mode === 'pressure' ? 60 : 10);
        });
        request.on('error', reject);
      }));
      assert.equal(row.downstream_finished, false);
      assert.ok(events(row).includes('downstream_disconnect'));
      assert.ok(events(row).indexOf('downstream_disconnect') < events(row).indexOf('proxy_cleanup'));
      if (mode === 'pressure') assert.equal(backpressured, true);
    });
  }
  await t.test('revoked device and rotated PIN still deny before upstream traffic', async () => {
    const count = received.length;
    allowed = false;
    let result = await fetch(url('normal')); assert.equal(result.status, 403); await result.text();
    allowed = true; pin = 'ROTATED';
    result = await fetch(url('normal', 'adult')); assert.equal(result.status, 403); await result.text();
    assert.equal(received.length, count);
  });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|cdn\.example|https:\/\/|bytes=|ROTATED/);
});
