const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { createRequire } = require('node:module');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { adultRequestPolicy } = require('../utils/adultStreamPolicy.cjs');
const { createPlaybackLogging } = require('../utils/playbackLogging.cjs');
const { createHlsUpstreamDiagnostics } = require('../utils/hlsUpstreamDiagnostics.cjs');
const { createPlaybackAssetReader } = require('../utils/playbackAssetHttp.cjs');
const { probeAdultStreamFormat } = require('../utils/adultStreamFormat.cjs');
const { createAdultTokens } = require('../utils/adultAccess.cjs');
const { addonVersion } = require('../utils/adultAddons.cjs');

async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('real HTTP Adult direct media preserves ranges, rewrites HLS and revokes child access', async t => {
  const received = [];
  const logs = [];
  const logger = { log: (tag, value) => logs.push({ tag, ...JSON.parse(value) }), warn: (tag, value) => logs.push({ tag, ...JSON.parse(value) }) };
  const logging = createPlaybackLogging({ logger, secret: 'logging-fixture-only' });
  const upstream = await listen(t, http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    if (req.url === '/blocked') { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('SESSION-SECRET blocked'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://cdn.example/video.mp4' }); res.end(); return; }
    if (req.url === '/cross-origin') { res.writeHead(302, { Location: 'https://other.example/video.mp4' }); res.end(); return; }
    if (req.url === '/opaque') { res.writeHead(302, { Location: 'https://cdn.example/hop' }); res.end(); return; }
    if (req.url === '/hop') { res.writeHead(302, { Location: 'https://other.example/manifest' }); res.end(); return; }
    if (req.url === '/manifest') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant\n'); return;
    }
    if (req.url === '/variant') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nsegment.ts\n'); return;
    }
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
      if (id === '../utils/playbackLogging.cjs') return { playbackLogging: logging };
      if (id === '../utils/hlsUpstreamDiagnostics.cjs') return { createHlsUpstreamDiagnostics: options => createHlsUpstreamDiagnostics({ ...options, logger, logging }) };
      if (id === 'node:http' || id === 'node:https') return transport;
      if (id === 'node:dns/promises') return { lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ adult_enabled: allowed }) };
      if (id === '../utils/adultAccess.cjs') return { readAdultPin: async () => fingerprint ? { fingerprint } : null };
      return routeRequire(id);
    } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const app = express(); app.use('/v1', context.module.exports);
  const reader = createPlaybackAssetReader({ lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestHttp: (url, options, callback) => { const req = transport.request(url, options, callback); req.end(); return req; },
    requestHttps: (url, options, callback) => { const req = transport.request(url, options, callback); req.end(); return req; } });
  const adultFile = require.resolve('./adult.routes.cjs');
  const adultRequire = createRequire(adultFile);
  const adultContext = vm.createContext({ module: { exports: {} }, Buffer, URL, process: { env: { JWT_SECRET: 'fixture-only-key' } },
    require: id => {
      if (id === '../middleware/authJwt.cjs') return { authJwt: (_req, _res, next) => next() };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({}) };
      return adultRequire(id);
    } });
  vm.runInContext(fs.readFileSync(adultFile, 'utf8'), adultContext, { filename: adultFile });
  const addon = { id: 'fixture', enabled: true, scopes: ['adult'], manifest_url: 'https://addon.example/manifest.json' };
  const tokens = createAdultTokens('fixture-only-key');
  app.use(express.json());
  app.use('/v1', adultContext.module.exports.createAdultRouter({ logging,
    auth: (req, _res, next) => { req.device = { device_id: 7 }; next(); },
    readSettings: async () => ({ adult_enabled: allowed, stremio_addons: [addon] }),
    readPin: async () => ({ fingerprint, pin: '1234' }), tokens: () => tokens,
    probeFormat: (url, headers) => probeAdultStreamFormat(url, headers, { reader }),
    history: { owner: async () => 'owner', list: async () => [] },
  }));
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
  const denial = logs.find(log => log.event === 'request_complete' && log.status === 403);
  assert.equal(denial.stage, 'authorization');
  allowed = true;
  const blockedUrl = wrap('http://cdn.example/blocked');
  const blocked = await fetch(blockedUrl); await blocked.text();
  assert.equal(blocked.status, 502);
  const failure = logs.find(log => log.tag === '[movie-upstream-failure]');
  assert.equal(failure.status, 403); assert.equal(failure.stage, 'upstream_headers');
  const outcome = logs.find(log => log.event === 'request_complete' && log.request_id === failure.request_id);
  assert.equal(outcome.status, 502); assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.media_type, 'adult'); assert.equal(outcome.route, '/movies/stream/:ticket');
  const encoded = JSON.stringify(logs);
  assert.doesNotMatch(encoded, /SESSION-SECRET|cdn\.example|other\.example|pin-one/);
  assert.ok(!encoded.includes(new URL(blockedUrl).pathname));
  const grant = data => tokens.issue(data.source ? 'source' : 'unlock', 7,
    { ...data, fingerprint: 'pin-one', age_confirmed: true });
  const resolveResponse = await fetch(`${api}/v1/adult/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unlock_token: grant({}), source_token: grant({
      item: { addon_id: 'fixture', addon_version: addonVersion(addon), id: 'PRIVATE-ID', type: 'movie' },
      source: { url: 'http://cdn.example/opaque', request_headers: { Cookie: 'SESSION-SECRET' } },
    }) }) });
  assert.equal(resolveResponse.status, 200);
  const resolved = await resolveResponse.json();
  assert.equal(resolved.format, 'hls'); assert.equal(resolved.mimeType, 'application/vnd.apple.mpegurl');
  assert.ok(resolved.playbackUrl.endsWith('.m3u8'));
  const toApi = link => api + new URL(link).pathname;
  const master = await fetch(toApi(resolved.playbackUrl)); assert.equal(master.status, 200);
  const masterText = await master.text();
  const variantLink = masterText.split('\n').find(line => line.startsWith('https://'));
  assert.ok(variantLink.endsWith('.m3u8'));
  const variant = await fetch(toApi(variantLink)); assert.equal(variant.status, 200);
  const variantText = await variant.text();
  const childLinks = [...variantText.matchAll(/https:\/\/api\.758streamin\.com\/v1\/movies\/stream\/([A-Za-z0-9_-]+)/g)];
  assert.equal(childLinks.length, 2);
  for (const [, ticket] of childLinks) {
    const asset = await fetch(`${api}/v1/movies/stream/${ticket}`);
    assert.equal(asset.status, 200); await asset.arrayBuffer();
  }
  const count = received.length;
  fingerprint = 'rotated';
  const rotated = await fetch(toApi(resolved.playbackUrl)); assert.equal(rotated.status, 403); await rotated.text();
  fingerprint = 'pin-one'; allowed = false;
  const removed = await fetch(toApi(variantLink)); assert.equal(removed.status, 403); await removed.text();
  assert.equal(received.length, count);
  assert.doesNotMatch(JSON.stringify(logs), /SESSION-SECRET|PRIVATE-ID|cdn\.example|other\.example/);
});
