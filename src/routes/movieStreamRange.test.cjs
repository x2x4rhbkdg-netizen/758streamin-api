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

test('native HTTP conditional resume preserves origin semantics and authorization', async t => {
  const bytes = Buffer.from('0123456789'), received = [], logs = [];
  const etag = '"PRIVATE-version-2"', modified = 'Sat, 14 Nov 2026 12:00:00 GMT';
  let allowed = true, pin = 'PRIVATE-PIN';
  const upstream = await listen(t, http.createServer((req, res) => {
    received.push(req.headers);
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { Location: 'https://other.example/media' }); res.end(); return;
    }
    if (req.url.startsWith('/manifest')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', ETag: etag, 'Last-Modified': modified });
      res.end('#EXTM3U\nsegment.ts\n'); return;
    }
    const headers = { 'Content-Type': 'video/mp4', ETag: etag, 'Last-Modified': modified, 'Accept-Ranges': 'bytes' };
    // This fixture origin supports validators and all single-range forms used by players.
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const matches = !req.headers['if-range'] || [etag, modified].includes(req.headers['if-range']);
    if (match && matches && !req.url.startsWith('/ignore')) {
      const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
      if (start >= bytes.length || end < start) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': '0' }); res.end(); return;
      }
      const body = bytes.subarray(start, end + 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': body.length });
      res.end(body); return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': bytes.length }); res.end(bytes);
  }));
  const logger = { log: (_tag, json) => logs.push(JSON.parse(json)), warn: (_tag, json) => logs.push(JSON.parse(json)) };
  const logging = createPlaybackLogging({ logger, secret: 'fixture-log-key' });
  const filename = require.resolve('./movieStream.routes.cjs'), routeRequire = createRequire(filename);
  // Real HTTP request/response parsing; only network destination is remapped to loopback.
  const transport = { request: (url, options, callback) => http.request(new URL(url.pathname + url.search, upstream), {
    method: options.method, headers: options.headers, signal: options.signal, agent: false,
  }, callback) };
  const context = vm.createContext({ module: { exports: {} }, Buffer, URL, AbortController, setTimeout, clearTimeout,
    process: { env: { JWT_SECRET: 'fixture-ticket-key' } }, require(id) {
      if (id === 'node:http' || id === 'node:https') return transport;
      if (id === 'node:dns/promises') return { lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
      if (id === '../utils/playbackLogging.cjs') return { playbackLogging: logging };
      if (id === '../utils/hlsUpstreamDiagnostics.cjs') return { createHlsUpstreamDiagnostics: options => createHlsUpstreamDiagnostics({ ...options, logger, logging }) };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ anime_enabled: allowed, adult_enabled: allowed }) };
      if (id === '../utils/adultAccess.cjs') return { readAdultPin: async () => ({ fingerprint: pin }) };
      return routeRequire(id);
    } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const app = express(); app.use(context.module.exports);
  const api = await listen(t, http.createServer(app));
  const tickets = createPlaybackTickets('fixture-ticket-key');
  const url = (path = 'media', section = 'anime') => `${api}/movies/stream/${tickets.issue(
    `https://cdn.example/${path}?token=PRIVATE`, 'PRIVATE-DEVICE', section, section === 'adult' ? 'PRIVATE-PIN' : undefined)}`;

  await t.test('initial GET and HEAD expose the validators without changing cache policy', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(url(), { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), etag);
      assert.equal(response.headers.get('last-modified'), modified);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-length'), '10');
      assert.equal(await response.text(), method === 'HEAD' ? '' : bytes.toString());
    }
  });
  await t.test('matching ETag/date, open-ended and suffix ranges return exact bytes', async () => {
    for (const [range, validator, expected, contentRange] of [
      ['bytes=4-', etag, '456789', 'bytes 4-9/10'],
      ['bytes=2-5', modified, '2345', 'bytes 2-5/10'],
      ['bytes=-3', etag, '789', 'bytes 7-9/10'],
    ]) {
      const response = await fetch(url(), { headers: { Range: range, 'If-Range': validator } });
      assert.equal(received.at(-1)['if-range'], validator);
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(await response.text(), expected);
    }
  });
  await t.test('stale validators or origins ignoring Range remain full 200 responses', async () => {
    for (const [path, validator] of [['media', '"PRIVATE-old-version"'], ['media', 'Fri, 13 Nov 2026 12:00:00 GMT'], ['ignore', etag]]) {
      const response = await fetch(url(path), { headers: { Range: 'bytes=4-', 'If-Range': validator } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-range'), null);
      assert.equal(await response.text(), bytes.toString());
    }
  });
  await t.test('validators without Range are ignored and unrelated credentials are not forwarded', async () => {
    const response = await fetch(url(), { headers: { 'If-Range': etag, Authorization: 'Bearer PRIVATE', Cookie: 'PRIVATE' } });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(received.at(-1)['if-range'], undefined);
    assert.equal(received.at(-1).authorization, undefined); assert.equal(received.at(-1).cookie, undefined);
  });
  await t.test('redirects retain resume headers and unsatisfiable ranges remain 416', async () => {
    const response = await fetch(url('redirect'), { headers: { Range: 'bytes=4-', 'If-Range': etag } });
    assert.equal(response.status, 206); assert.equal(await response.text(), '456789');
    assert.equal(received.at(-1)['if-range'], etag); assert.equal(received.at(-2)['if-range'], etag);
    const rejected = await fetch(url(), { headers: { Range: 'bytes=99-' } });
    assert.equal(rejected.status, 416); assert.equal(rejected.headers.get('content-range'), 'bytes */10');
    await rejected.text();
  });
  await t.test('rewritten adult manifests never inherit upstream byte validators', async () => {
    const response = await fetch(url('manifest', 'adult'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), null); assert.equal(response.headers.get('last-modified'), null);
    assert.match(await response.text(), /\/movies\/stream\//);
  });
  await t.test('device revocation, PIN rotation and invalid multiranges still prevent upstream calls', async () => {
    const count = received.length;
    allowed = false;
    let response = await fetch(url(), { headers: { Range: 'bytes=4-', 'If-Range': etag } });
    assert.equal(response.status, 403); await response.text();
    allowed = true; pin = 'ROTATED';
    response = await fetch(url('media', 'adult'), { headers: { Range: 'bytes=4-', 'If-Range': etag } });
    assert.equal(response.status, 403); await response.text();
    response = await fetch(url(), { headers: { Range: 'bytes=1-2,4-5' } });
    assert.equal(response.status, 416); await response.text();
    assert.equal(received.length, count);
  });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|cdn\.example|other\.example|ROTATED|bytes=|Sat, 14/);
});
