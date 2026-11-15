const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { createPlaybackTickets, playbackTicketValue } = require('../utils/moviePlaybackTickets.cjs');
const { publicAddress } = require('../utils/scraperHttp.cjs');
const { createPlaybackLogging } = require('../utils/playbackLogging.cjs');
const { createHlsUpstreamDiagnostics } = require('../utils/hlsUpstreamDiagnostics.cjs');
function fixture({ enabled = true, anime_enabled = false, adult_enabled = false, pinFingerprint = 'pin-one', redirect, content = 'video', mime = 'video/mp4', requestFailures = [], addresses, upstreamStatus = 206 } = {}) {
  let handler, middleware, calls = [], logs = [];
  const logger = { log: (tag, value) => logs.push({ tag, ...JSON.parse(value) }), warn: (tag, value) => logs.push({ tag, ...JSON.parse(value) }) };
  const logging = createPlaybackLogging({ logger, secret: 'logging-fixture-only' });
  const context = { module: { exports: {} }, process: { env: { JWT_SECRET: 'test-secret' } }, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'express') return { Router: () => ({ use(value) { middleware = value; }, get(_path, callback) { handler = callback; } }) };
      if (name === '../utils/playbackLogging.cjs') return { playbackLogging: logging };
      if (name === '../utils/hlsUpstreamDiagnostics.cjs') return { createHlsUpstreamDiagnostics: options => createHlsUpstreamDiagnostics({ ...options, logger, logging }) };
      if (name === 'node:dns/promises') return { lookup: async (hostname) => addresses || [{ address: hostname === 'private.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }] };
      if (name === 'node:https' || name === 'node:http') return { request(url, options, callback) {
        calls.push({ url, options });
        const request = new EventEmitter(); request.setTimeout = () => {};
        request.end = () => {
          const code = requestFailures.shift();
          if (code) { queueMicrotask(() => request.emit('error', Object.assign(new Error('private upstream diagnostic'), { code }))); return; }
          const target = typeof redirect === 'function' ? redirect(url) : redirect;
          const response = Readable.from(target ? [] : [content]);
          response.statusCode = target ? 302 : upstreamStatus;
          response.headers = target ? { location: target } : { 'content-type': mime, 'content-range': 'bytes 0-4/5', 'content-length': String(Buffer.byteLength(content)) };
          callback(response);
        };
        return request;
      } };
      if (name === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ enabled, anime_enabled, adult_enabled }) };
      if (name === '../utils/adultAccess.cjs') return { readAdultPin: async () => pinFingerprint ? { fingerprint: pinFingerprint } : null };
      if (name === '../utils/moviePlaybackTickets.cjs') return { createPlaybackTickets, playbackTicketValue };
      if (name === '../utils/scraperHttp.cjs') return { publicAddress };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./movieStream.routes.cjs'), 'utf8'), context);
  async function run(url, range = 'bytes=0-4', ticket) {
    const res = new PassThrough(); let body = ''; res.headers = {}; res.code = 200; res.statusCode = 200;
    res.on('data', (chunk) => { body += chunk; });
    res.set = (key, value) => { res.headers[key] = value; return res; };
    res.status = (code) => { res.code = code; res.statusCode = code; return res; };
    res.json = (value) => res.end(JSON.stringify(value));
    res.sendStatus = (code) => { res.code = code; res.statusCode = code; res.end(); };
    const value = ticket || createPlaybackTickets('test-secret').issue(url, 1);
    const req = { path: `/movies/stream/${value}`, params: { ticket: value }, method: 'GET', get: name => name === 'range' ? range : undefined };
    await new Promise((resolve, reject) => middleware(req, res, () => handler(req, res).then(resolve, reject)));
    return { code: res.code, headers: res.headers, body };
  }
  return { run, calls, logs };
}
test('protected stream forwards range, pipes content and never forwards credentials in response headers', async () => {
  const { run, calls } = fixture();
  const result = await run('https://cdn.example/movie.mp4?token=private-key');
  assert.equal(result.code, 206); assert.equal(result.body, 'video');
  assert.equal(result.headers['content-range'], 'bytes 0-4/5');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-4');
  const pinned = await new Promise((resolve, reject) => calls[0].options.lookup('cdn.example', {},
    (error, address) => error ? reject(error) : resolve(address)));
  assert.equal(pinned, '8.8.8.8');
});

test('Adult streaming rechecks independent access and PIN rotation/removal on each request', async () => {
  const ticket = createPlaybackTickets('test-secret').issue('https://cdn.example/movie.mp4', 1, 'adult', 'pin-one');
  assert.equal((await fixture({ enabled: false, adult_enabled: true }).run(null, undefined, ticket)).code, 206);
  for (const options of [{ adult_enabled: false }, { adult_enabled: true, pinFingerprint: 'pin-two' }, { adult_enabled: true, pinFingerprint: null }]) {
    const f = fixture(options);
    assert.equal((await f.run(null, undefined, ticket)).code, 403);
    assert.equal(f.calls.length, 0);
  }
});

test('Adult HLS playlists hide upstream URLs and issue PIN-scoped segment tickets', async () => {
  const ticket = createPlaybackTickets('test-secret').issue('https://cdn.example/path/master.m3u8', 1, 'adult', 'pin-one');
  const { run } = fixture({ adult_enabled: true, mime: 'application/vnd.apple.mpegurl', content: '#EXTM3U\nsegment.ts?key=private\n' });
  const result = await run(null, undefined, ticket);
  assert.equal(result.code, 200);
  assert.equal(result.body.includes('private'), false);
  const segment = result.body.split('\n')[1].split('/').at(-1);
  const record = createPlaybackTickets('test-secret').read(segment);
  assert.equal(record.url, 'https://cdn.example/path/segment.ts?key=private');
  assert.equal(record.section, 'adult');
  assert.equal(record.adultPinFingerprint, 'pin-one');
  assert.equal(record.adultAgeConfirmed, true);
});
test('legacy Adult playback tickets without the 18+ marker fail before any upstream request', async () => {
  const crypto = require('node:crypto');
  const key = crypto.createHmac('sha256', 'test-secret').update('streamin-movie-playback-v1').digest();
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ url: 'https://cdn.example/movie.mp4', device: '1', section: 'adult', adultPinFingerprint: 'pin-one', expires: Date.now() + 60000 })), cipher.final()]);
  const ticket = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  const f = fixture({ adult_enabled: true });
  assert.equal((await f.run(null, undefined, ticket)).code, 403); assert.equal(f.calls.length, 0);
});
test('protected stream blocks invalid tickets, revoked access, private destinations, unsafe redirects and multiranges', async () => {
  assert.equal((await fixture().run('https://cdn.example/movie', undefined, 'tampered')).code, 403);
  assert.equal((await fixture({ enabled: false }).run('https://cdn.example/movie')).code, 403);
  const privateTarget = fixture();
  assert.equal((await privateTarget.run('https://private.example/movie')).code, 502);
  assert.equal(privateTarget.calls.length, 0);
  assert.equal((await fixture({ redirect: 'https://private.example/movie' }).run('https://cdn.example/movie')).code, 502);
  assert.equal((await fixture().run('https://cdn.example/movie', 'bytes=0-1,3-4')).code, 416);
});

test('protected anime tickets enforce independent device permission on every stream request', async () => {
  const url = 'https://cdn.example/anime.mp4';
  const ticket = createPlaybackTickets('test-secret').issue(url, 1, 'anime');
  assert.equal((await fixture({ enabled: false, anime_enabled: true }).run(url, undefined, ticket)).code, 206);
  assert.equal((await fixture({ enabled: true, anime_enabled: false }).run(url, undefined, ticket)).code, 403);
  assert.equal((await fixture({ enabled: false, anime_enabled: true }).run(url)).code, 403);
});

test('upstream network failures return 502, release capacity and do not break the next request', async () => {
  const f = fixture({ requestFailures: Array(20).fill('ENETUNREACH') });
  for (let i = 0; i < 20; i++) {
    const response = await f.run('https://cdn.example/movie.mp4?secret=private');
    assert.equal(response.code, 502);
    assert.equal(response.body, JSON.stringify({ error: 'Movie stream temporarily unavailable' }));
    assert.equal(response.body.includes('private'), false);
  }
  const next = await f.run('https://cdn.example/movie.mp4');
  assert.equal(next.code, 206); assert.equal(next.body, 'video');
});

test('HTTP Adult direct playback retains PIN checks without enabling HTTP for general movies', async () => {
  const url = 'http://cdn.example/movie.mp4?token=SECRET';
  const ticket = createPlaybackTickets('test-secret').issue(url, 1, 'adult', 'pin-one');
  const f = fixture({ adult_enabled: true });
  const result = await f.run(null, undefined, ticket);
  assert.equal(result.code, 206); assert.equal(result.body, 'video');
  assert.equal(f.calls[0].url.protocol, 'http:');
  assert.equal((await fixture().run(url)).code, 502);
  for (const options of [{ adult_enabled: false }, { adult_enabled: true, pinFingerprint: 'changed' }]) {
    const denied = fixture(options);
    assert.equal((await denied.run(null, undefined, ticket)).code, 403);
    assert.equal(denied.calls.length, 0);
  }
});

test('Adult headers apply to the original origin and same-origin redirects but not other hosts or HTTP downgrades', async () => {
  const url = 'https://cdn.example/original.mp4';
  const { adultRequestPolicy } = require('../utils/adultStreamPolicy.cjs');
  const policy = adultRequestPolicy(url, { 'User-Agent': 'Fixture', Cookie: 'SECRET', Authorization: 'Bearer SECRET', Referer: 'https://site.example/' });
  const ticket = createPlaybackTickets('test-secret').issue(url, 1, 'adult', 'pin-one', policy);
  for (const target of ['https://cdn.example/redirect.mp4', 'https://other.example/redirect.mp4', 'http://cdn.example/redirect.mp4']) {
    const f = fixture({ adult_enabled: true, redirect: source => source.pathname === '/original.mp4' ? target : undefined });
    const result = await f.run(null, undefined, ticket);
    assert.equal(result.code, 206); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].options.headers.cookie, 'SECRET');
    assert.equal(f.calls[1].options.headers.cookie, target.startsWith('https://cdn.example/') ? 'SECRET' : undefined);
    assert.equal(f.calls[1].options.headers.authorization, target.startsWith('https://cdn.example/') ? 'Bearer SECRET' : undefined);
    assert.equal(f.calls[1].options.headers.Range, 'bytes=0-4');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('HTTP Adult redirect destinations remain DNS-validated and unsupported ports/schemes stay blocked', async () => {
  const url = 'http://cdn.example/original.mp4';
  const ticket = createPlaybackTickets('test-secret').issue(url, 1, 'adult', 'pin-one');
  for (const target of ['http://private.example/file', 'https://private.example/file', 'http://cdn.example:3306/file', 'file:///etc/passwd']) {
    const f = fixture({ adult_enabled: true, redirect: () => target });
    assert.equal((await f.run(null, undefined, ticket)).code, 502);
    assert.equal(f.calls.length, 1);
  }
});

test('Adult HLS child tickets retain the original header scope and require the same PIN', async () => {
  const { adultRequestPolicy } = require('../utils/adultStreamPolicy.cjs');
  const url = 'http://cdn.example/master.m3u8';
  const ticket = createPlaybackTickets('test-secret').issue(url, 1, 'adult', 'pin-one', adultRequestPolicy(url, { Cookie: 'SECRET' }));
  const f = fixture({ adult_enabled: true, mime: 'application/vnd.apple.mpegurl',
    content: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\npart.ts\nhttps://other.example/variant.m3u8\n' });
  const result = await f.run(null, undefined, ticket);
  assert.equal(result.code, 200); assert.equal(f.calls[0].options.headers.cookie, 'SECRET');
  assert.doesNotMatch(result.body, /SECRET|cdn\.example|other\.example/);
  const links = [...result.body.matchAll(/https:\/\/api\.758streamin\.com\/v1\/movies\/stream\/([A-Za-z0-9_-]+)/g)];
  assert.equal(links.length, 3);
  for (const [, child] of links) {
    const record = createPlaybackTickets('test-secret').read(child);
    assert.equal(record.requestPolicy.origin, 'http://cdn.example');
    assert.equal(record.requestPolicy.headers.cookie, 'SECRET');
    const playlist = record.url.endsWith('.m3u8');
    const asset = fixture({ adult_enabled: true, ...(playlist ? { mime: 'application/vnd.apple.mpegurl', content: '#EXTM3U\npart.ts\n' } : {}) });
    assert.equal((await asset.run(null, undefined, child)).code, playlist ? 200 : 206);
    assert.equal(asset.calls[0].options.headers.cookie, record.url.startsWith('http://cdn.example/') ? 'SECRET' : undefined);
    const revoked = fixture({ adult_enabled: true, pinFingerprint: null });
    assert.equal((await revoked.run(null, undefined, child)).code, 403);
    assert.equal(revoked.calls.length, 0);
  }
});

test('dual-stack fallback still rejects a mixed public/private DNS answer before connecting', async () => {
  const f = fixture({ addresses: [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }] });
  assert.equal((await f.run('https://cdn.example/movie.mp4')).code, 502);
  assert.equal(f.calls.length, 0);
});

test('protected stream diagnostics identify upstream rejection, network errors and manifest rewrite failures without secrets', async () => {
  const cases = [
    [{ upstreamStatus: 403 }, 'upstream_headers', 403],
    [{ requestFailures: ['ENETUNREACH'] }, 'connect', 'network-error'],
    [{ adult_enabled: true, mime: 'application/vnd.apple.mpegurl', content: 'PRIVATE upstream error body' }, 'manifest_rewrite', 'network-error'],
  ];
  for (const [options, stage, status] of cases) {
    const f = fixture(options);
    const url = 'https://cdn.example/PRIVATE.mp4?token=PRIVATE';
    const ticket = createPlaybackTickets('test-secret').issue(url, 1, options.adult_enabled ? 'adult' : undefined, options.adult_enabled ? 'pin-one' : undefined);
    assert.equal((await f.run(null, undefined, ticket)).code, 502);
    const failure = f.logs.find(log => log.tag === '[movie-upstream-failure]');
    assert.ok(failure); assert.equal(failure.stage, stage); assert.equal(failure.status, status);
    assert.equal(failure.route, '/movies/stream/:ticket');
    assert.match(failure.request_id, /^[a-f0-9-]{36}$/);
    assert.match(failure.source_ref, /^[a-f0-9]{24}$/);
    const encoded = JSON.stringify(f.logs);
    assert.doesNotMatch(encoded, /PRIVATE|cdn\.example|pin-one/);
    assert.ok(!encoded.includes(ticket));
  }
});

test('HTML responses and cross-origin header stripping are visible without dumping content or credentials', async () => {
  const url = 'https://cdn.example/start';
  const { adultRequestPolicy } = require('../utils/adultStreamPolicy.cjs');
  const ticket = createPlaybackTickets('test-secret').issue(url, 1, 'adult', 'pin-one', adultRequestPolicy(url, { Cookie: 'PRIVATE' }));
  const f = fixture({ adult_enabled: true, upstreamStatus: 200, mime: 'text/html; PRIVATE', content: 'PRIVATE body',
    redirect: target => target.hostname === 'cdn.example' ? 'https://other.example/player' : undefined });
  const result = await f.run(null, undefined, ticket);
  // Diagnostic-only change: do not alter provider response behavior in this patch.
  assert.equal(result.code, 200);
  const responses = f.logs.filter(log => log.event === 'stream_response');
  assert.equal(responses.length, 2);
  assert.equal(responses[0].addon_headers_applied, true);
  assert.equal(responses[1].addon_headers_applied, false);
  assert.equal(responses[1].redirect_count, 1); assert.equal(responses[1].response_kind, 'html');
  assert.equal(responses[0].request_id, responses[1].request_id);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|cdn\.example|other\.example/);
});
