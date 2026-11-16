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

const IDLE_MS = 250;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('Local backpressure fixture did not settle');
    await sleep(10);
  }
}
async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function consume(f, response) {
  let bytes = 0;
  const deadline = setTimeout(() => response.destroy(new Error('Local fixture body did not finish')), 5000);
  try {
    await new Promise((resolve, reject) => {
      response.on('data', chunk => { bytes += chunk.length; });
      response.once('end', resolve);
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Local fixture body aborted')));
      response.resume();
    });
    return bytes;
  } catch (error) {
    // Safe test-only state makes a stalled fixture actionable instead of waiting for HTTP keep-alive expiry.
    console.error(JSON.stringify({ fixture_bytes: bytes, lifecycle: f.lifecycle(),
      upstream_complete: f.states.at(-1)?.incoming?.complete,
      upstream_paused: f.states.at(-1)?.incoming?.isPaused(),
      downstream_finished: f.states.at(-1)?.downstream?.writableFinished,
      downstream_needs_drain: f.states.at(-1)?.downstream?.writableNeedDrain,
      pauses: f.states.at(-1)?.pauseCount, resumes: f.states.at(-1)?.resumeCount,
      timeouts: f.states.at(-1)?.timeouts }));
    throw error;
  } finally { clearTimeout(deadline); }
}

async function fixture(t, { idleMs = IDLE_MS, stallMs = 1500, holdWrites = false } = {}) {
  const logs = [], states = [], clientResponses = new Set();
  t.after(() => assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|cdn\.example|token=/));
  let downstream, held, releaseWrite;
  const logger = { log: (_tag, text) => logs.push(JSON.parse(text)), warn: (_tag, text) => logs.push(JSON.parse(text)) };
  const logging = createPlaybackLogging({ logger, secret: 'fixture-log-key' });
  const upstream = await listen(t, http.createServer((req, res) => {
    const state = states.at(-1);
    res.on('error', () => {});
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { Location: 'https://cdn.example/steady' });
      res.write('PRIVATE redirect body');
      res.once('close', () => { state.redirectClosed = true; });
      return;
    }
    if (req.url.startsWith('/stall')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '1000' });
      res.write(Buffer.alloc(5)); return;
    }
    if (req.url.startsWith('/steady')) {
      let sent = 0;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '10' });
      res.write(Buffer.alloc(1));
      const timer = setInterval(() => {
        if (++sent === 9) { clearInterval(timer); res.end(Buffer.alloc(1)); }
        else res.write(Buffer.alloc(1));
      }, 50);
      res.once('close', () => clearInterval(timer)); return;
    }
    // Finite media larger than native TCP buffers; allocate only one reusable chunk.
    const size = 32 * 1024 * 1024, chunk = Buffer.alloc(65536);
    let sent = 0;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
    const pump = () => {
      while (!res.destroyed && sent < size) {
        sent += chunk.length;
        if (!res.write(chunk)) { state.originBackpressured = true; return; }
      }
      if (!res.destroyed) res.end();
    };
    res.on('drain', pump); pump();
  }));
  const filename = require.resolve('./movieStream.routes.cjs'), routeRequire = createRequire(filename);
  const transport = { request(url, options, callback) {
    const state = { downstream, originBackpressured: false, pauseCount: 0, resumeCount: 0, timeouts: [] };
    states.push(state);
    const request = http.request(new URL(url.pathname, upstream), {
      method: options.method, headers: options.headers, signal: options.signal, agent: false,
    }, response => {
      state.incoming = response;
      response.on('pause', () => { state.pauseCount++; });
      response.on('resume', () => { state.resumeCount++; });
      callback(response);
    });
    const nativeTimeout = request.setTimeout.bind(request);
    request.setTimeout = (ms, handler) => {
      if (ms === 0) return nativeTimeout(0);
      assert.equal(ms, 30000);
      return nativeTimeout(idleMs, () => {
        // Test-only snapshots contain numbers/booleans, never URLs or bytes of media.
        state.timeouts.push({ upstreamPaused: state.incoming?.isPaused() === true,
          upstreamComplete: state.incoming?.complete === true,
          upstreamBufferedBytes: state.incoming?.readableLength || 0,
          downstreamNeedsDrain: state.downstream?.writableNeedDrain === true,
          downstreamBufferedBytes: state.downstream?.writableLength || 0 });
        handler();
      });
    };
    return request;
  } };
  const context = vm.createContext({ module: { exports: {} }, Buffer, URL, AbortController, setTimeout, clearTimeout,
    process: { env: { JWT_SECRET: 'fixture-ticket-key' } }, require(id) {
      if (id === 'node:http' || id === 'node:https') return transport;
      if (id === 'node:dns/promises') return { lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ enabled: true }) };
      if (id === '../utils/playbackLogging.cjs') return { playbackLogging: logging };
      if (id === '../utils/hlsUpstreamDiagnostics.cjs') return { createHlsUpstreamDiagnostics: options => createHlsUpstreamDiagnostics({ ...options, logger, logging }) };
      if (id === '../utils/movieBodyTimeout.cjs') return { watchMovieBody: (up, down, options) =>
        routeRequire(id).watchMovieBody(up, down, { signal: options.signal, idleMs, stallMs, onTimeout(reason, limit) {
          const state = states.at(-1);
          state.timeouts.push({ reason, upstreamPaused: up.isPaused(), upstreamComplete: up.complete,
            upstreamBufferedBytes: up.readableLength, downstreamNeedsDrain: down.writableNeedDrain,
            downstreamBufferedBytes: down.writableLength });
          options.onTimeout(reason, limit);
        } }) };
      return routeRequire(id);
    } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const app = express();
  app.use((req, res, next) => {
    downstream = res;
    if (holdWrites) {
      const write = res.write.bind(res), prototype = Object.getPrototypeOf(res);
      let holding = true;
      Object.defineProperty(res, 'writableNeedDrain', { configurable: true,
        get: () => Boolean(held) || Reflect.get(prototype, 'writableNeedDrain', res) });
      res.write = (...args) => {
        if (!holding) return write(...args);
        assert.equal(held, undefined);
        held = args;
        res.flushHeaders();
        return false;
      };
      releaseWrite = () => {
        holding = false;
        const args = held; held = undefined;
        assert.ok(args);
        if (write(...args)) res.emit('drain');
      };
    }
    next();
  });
  app.use(context.module.exports);
  const api = await listen(t, http.createServer(app));
  t.after(() => { for (const response of clientResponses) response.destroy(); });
  const ticket = mode => createPlaybackTickets('fixture-ticket-key').issue(`https://cdn.example/${mode}?token=PRIVATE`, 'PRIVATE-DEVICE');
  const open = mode => new Promise((resolve, reject) => {
    const request = http.get(`${api}/movies/stream/${ticket(mode)}`, response => {
      clientResponses.add(response);
      response.on('error', () => {});
      resolve(response);
    });
    request.on('error', reject);
  });
  return { logs, states, open, releaseWrite: () => releaseWrite(),
    lifecycle: () => logs.find(row => row.event === 'stream_lifecycle') };
}

test('native movie proxy idle timeout and buffering investigation', async t => {
  await t.test('redirect bodies are closed while the final response keeps body-idle protection', async t => {
    const f = await fixture(t), response = await f.open('redirect');
    let count = 0;
    for await (const chunk of response) count += chunk.length;
    await waitFor(f.lifecycle);
    assert.equal(count, 10); assert.equal(f.states.length, 2);
    assert.equal(f.states[0].redirectClosed, true);
    assert.ok(f.states.every(state => state.timeouts.length === 0));
    assert.equal(f.lifecycle().downstream_finished, true);
  });
  await t.test('a truly idle source times out without downstream backpressure', async t => {
    const f = await fixture(t), response = await f.open('stall');
    response.resume();
    await waitFor(f.lifecycle);
    const state = f.states[0];
    assert.equal(state.timeouts.length, 1);
    assert.equal(state.timeouts[0].upstreamPaused, false);
    assert.equal(f.lifecycle().upstream_bytes_consumed, 5);
    assert.ok(f.lifecycle().events.some(item => item.event === 'upstream_idle_timeout'));
    t.diagnostic(JSON.stringify({ scenario: 'source_idle', timeout: state.timeouts[0] }));
  });
  await t.test('regular source progress survives beyond the socket idle interval', async t => {
    const f = await fixture(t), started = Date.now(), response = await f.open('steady');
    let count = 0;
    for await (const chunk of response) count += chunk.length;
    await waitFor(f.lifecycle);
    assert.ok(Date.now() - started > IDLE_MS);
    assert.equal(count, 10); assert.equal(f.states[0].timeouts.length, 0);
    assert.equal(f.lifecycle().upstream_complete, true);
    assert.equal(f.lifecycle().downstream_finished, true);
  });
  await t.test('a short paused client resumes through native backpressure without data loss', async t => {
    const f = await fixture(t), response = await f.open('bulk');
    response.pause();
    await waitFor(() => f.states[0].pauseCount > 0);
    await sleep(25);
    let count = 0;
    for await (const chunk of response) count += chunk.length;
    await waitFor(f.lifecycle);
    assert.equal(count, 32 * 1024 * 1024);
    assert.ok(f.states[0].originBackpressured);
    assert.equal(f.states[0].timeouts.length, 0);
    assert.equal(f.lifecycle().upstream_complete, true);
    assert.equal(f.lifecycle().downstream_finished, true);
  });
  await t.test('controlled write backpressure beyond source idle resumes without timeout or data loss', async t => {
    const f = await fixture(t, { holdWrites: true }), response = await f.open('bulk');
    await waitFor(() => f.states[0].incoming?.isPaused());
    await sleep(IDLE_MS * 2);
    assert.equal(f.lifecycle(), undefined);
    assert.equal(f.states[0].timeouts.length, 0);
    const received = consume(f, response);
    f.releaseWrite();
    const bytes = await received;
    await waitFor(f.lifecycle);
    assert.equal(bytes, 32 * 1024 * 1024);
    assert.equal(f.lifecycle().downstream_finished, true);
    assert.equal(f.states[0].timeouts.length, 0);
  });
  await t.test('a client that never drains reaches the bounded downstream stall limit', async t => {
    const f = await fixture(t), response = await f.open('bulk');
    response.pause();
    await waitFor(f.lifecycle);
    const state = f.states[0];
    assert.ok(state.originBackpressured); assert.ok(state.pauseCount > 0);
    assert.equal(state.timeouts.length, 1);
    assert.equal(state.timeouts[0].upstreamPaused, true);
    assert.equal(state.timeouts[0].upstreamComplete, false);
    assert.ok(state.timeouts[0].upstreamBufferedBytes > 0);
    assert.equal(state.timeouts[0].downstreamNeedsDrain, true);
    assert.equal(f.lifecycle().downstream_finished, false);
    assert.ok(f.lifecycle().events.some(item => item.event === 'downstream_stall_timeout'));
    const failure = f.logs.find(item => item.failure_type);
    assert.equal(failure.failure_type, 'timeout');
    assert.equal(failure.timeout_ms, 1500);
    t.diagnostic(JSON.stringify({ scenario: 'client_paused', timeout: state.timeouts[0],
      consumed: f.lifecycle().upstream_bytes_consumed, pauses: state.pauseCount, resumes: state.resumeCount }));
    response.destroy();
    // The stalled transfer must relinquish its reservation and timers before another playback.
    const next = await f.open('steady'); let bytes = 0;
    for await (const chunk of next) bytes += chunk.length;
    assert.equal(next.statusCode, 200); assert.equal(bytes, 10);
    await waitFor(() => f.logs.filter(item => item.event === 'stream_lifecycle').length === 2);
    assert.equal(f.states.at(-1).timeouts.length, 0);
  });
});

test('controlled backpressure exceeding the production 30-second body idle window resumes intact', {
  // Allow workstation sleep/clock overruns; consume() still bounds an actual stalled read.
  skip: process.env.MOVIE_PROXY_LONG_IDLE_TEST !== '1', timeout: 600000,
}, async t => {
  const f = await fixture(t, { idleMs: 30000, stallMs: 120000, holdWrites: true }), response = await f.open('bulk');
  await waitFor(() => f.states[0].incoming?.isPaused());
  await sleep(31000);
  const state = f.states[0];
  assert.equal(state.timeouts.length, 0);
  assert.equal(f.lifecycle(), undefined);
  const received = consume(f, response);
  f.releaseWrite();
  const bytes = await received;
  await waitFor(f.lifecycle);
  assert.equal(bytes, 32 * 1024 * 1024);
  assert.equal(f.lifecycle().upstream_complete, true);
  assert.equal(f.lifecycle().downstream_finished, true);
  assert.equal(state.timeouts.length, 0);
  t.diagnostic(JSON.stringify({ scenario: 'controlled_write_hold_31s_then_drained', bytes, complete: true }));
});
