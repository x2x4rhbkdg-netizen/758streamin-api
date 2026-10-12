const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { publicAddress } = require('../utils/scraperHttp.cjs');
function fixture({ enabled = true, redirect } = {}) {
  let handler, calls = [];
  const context = { module: { exports: {} }, process: { env: { JWT_SECRET: 'test-secret' } }, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'express') return { Router: () => ({ get(_path, callback) { handler = callback; } }) };
      if (name === 'node:dns/promises') return { lookup: async (hostname) => [{ address: hostname === 'private.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }] };
      if (name === 'node:https') return { request(url, options, callback) {
        calls.push({ url, options });
        const request = new EventEmitter(); request.setTimeout = () => {};
        request.end = () => {
          const response = Readable.from(redirect ? [] : ['video']);
          response.statusCode = redirect ? 302 : 206;
          response.headers = redirect ? { location: redirect } : { 'content-type': 'video/mp4', 'content-range': 'bytes 0-4/5', 'content-length': '5' };
          callback(response);
        };
        return request;
      } };
      if (name === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({ enabled }) };
      if (name === '../utils/moviePlaybackTickets.cjs') return { createPlaybackTickets };
      if (name === '../utils/scraperHttp.cjs') return { publicAddress };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./movieStream.routes.cjs'), 'utf8'), context);
  async function run(url, range = 'bytes=0-4', ticket) {
    const res = new PassThrough(); let body = ''; res.headers = {}; res.code = 200;
    res.on('data', (chunk) => { body += chunk; });
    res.set = (key, value) => { res.headers[key] = value; return res; };
    res.status = (code) => { res.code = code; return res; };
    res.json = (value) => res.end(JSON.stringify(value));
    res.sendStatus = (code) => { res.code = code; res.end(); };
    await handler({ params: { ticket: ticket || createPlaybackTickets('test-secret').issue(url, 1) }, method: 'GET', get: () => range }, res);
    return { code: res.code, headers: res.headers, body };
  }
  return { run, calls };
}
test('protected stream forwards range, pipes content and never forwards credentials in response headers', async () => {
  const { run, calls } = fixture();
  const result = await run('https://cdn.example/movie.mp4?token=private-key');
  assert.equal(result.code, 206); assert.equal(result.body, 'video');
  assert.equal(result.headers['content-range'], 'bytes 0-4/5');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-4');
  let pinned;
  calls[0].options.lookup('cdn.example', {}, (_error, address) => { pinned = address; });
  assert.equal(pinned, '8.8.8.8');
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
