const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { createRequire } = require('node:module');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { adultRequestPolicy } = require('../utils/adultStreamPolicy.cjs');

async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('real HTTP Adult direct media preserves ranges, rewrites HLS and revokes child access', async t => {
  const received = [];
  const upstream = await listen(t, http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://cdn.example/video.mp4' }); res.end(); return; }
    if (req.url === '/cross-origin') { res.writeHead(302, { Location: 'https://other.example/video.mp4' }); res.end(); return; }
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nsegment.ts\n'); return;
    }
    const bytes = req.url === '/key.bin' ? Buffer.from('0123456789abcdef') : Buffer.from([0, 1, 2, 255, 4]);
    if (req.url !== '/key.bin' && req.headers.range === 'bytes=1-3') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 1-3/5', 'Content-Length': 3 });
      res.end(bytes.subarray(1, 4)); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Set-Cookie': 'private=SECRET' });
    res.end(bytes);
  }));
  let allowed = true, fingerprint = 'pin-one';
  const filename = require.resolve('./movieStream.routes.cjs');
  const routeRequire = createRequire(filename);
  // Remap only transport to loopback after production URL/DNS/header checks.
  const transport = { request: (url, options, callback) => http.request(new URL(url.pathname + url.search, upstream),
    { method: options.method, headers: options.headers, signal: options.signal, agent: false }, callback) };
  const context = vm.createContext({ module: { exports: {} }, process: { env: { JWT_SECRET: 'fixture-only-key' } },
    Buffer, URL, AbortController, setTimeout, clearTimeout, require: id => {
      if (id === 'node:http' || id === 'node:https') return transport;
      if (id === 'node:dns/promises') return { lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ adult_enabled: allowed }) };
      if (id === '../utils/adultAccess.cjs') return { readAdultPin: async () => fingerprint ? { fingerprint } : null };
      return routeRequire(id);
    } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const app = express(); app.use('/v1', context.module.exports);
  const api = await listen(t, http.createServer(app));
  const tickets = createPlaybackTickets('fixture-only-key');
  const wrap = url => `${api}/v1/movies/stream/${tickets.issue(url, 7, 'adult', 'pin-one',
    adultRequestPolicy(url, { Cookie: 'SESSION-SECRET', 'User-Agent': 'Fixture' }))}`;
  const media = await fetch(wrap('http://cdn.example/redirect'), { headers: { Range: 'bytes=1-3' } });
  assert.equal(media.status, 206); assert.equal(media.headers.get('content-range'), 'bytes 1-3/5');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from([1, 2, 255]));
  assert.equal(received[0].headers.cookie, 'SESSION-SECRET'); assert.equal(received[1].headers.cookie, 'SESSION-SECRET');
  assert.equal(media.headers.get('location'), null); assert.equal(media.headers.get('set-cookie'), null);
  const cross = await fetch(wrap('http://cdn.example/cross-origin')); await cross.arrayBuffer();
  assert.equal(cross.status, 200); assert.equal(received.at(-1).headers.cookie, undefined);
  const manifest = await fetch(wrap('http://cdn.example/master.m3u8'));
  const text = await manifest.text(); assert.equal(manifest.status, 200);
  assert.doesNotMatch(text, /SESSION-SECRET|cdn\.example|http:\/\//);
  const links = [...text.matchAll(/https:\/\/api\.758streamin\.com\/v1\/movies\/stream\/([A-Za-z0-9_-]+)/g)];
  assert.equal(links.length, 2);
  for (const [, ticket] of links) {
    const child = await fetch(`${api}/v1/movies/stream/${ticket}`);
    assert.equal(child.status, 200); await child.arrayBuffer();
    assert.equal(received.at(-1).headers.cookie, 'SESSION-SECRET');
    assert.equal(child.headers.get('set-cookie'), null);
  }
  const before = received.length;
  fingerprint = 'rotated';
  const denied = await fetch(`${api}/v1/movies/stream/${links[0][1]}`);
  assert.equal(denied.status, 403); await denied.text();
  fingerprint = 'pin-one'; allowed = false;
  const revoked = await fetch(`${api}/v1/movies/stream/${links[1][1]}`);
  assert.equal(revoked.status, 403); await revoked.text();
  assert.equal(received.length, before);
});
