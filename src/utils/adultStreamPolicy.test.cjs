const test = require('node:test');
const assert = require('node:assert/strict');
const { adultStreamUrl, addonRequestHeaders, adultRequestPolicy, headersForDestination } = require('./adultStreamPolicy.cjs');

test('Adult direct URL policy permits only HTTP/HTTPS standard ports and rejects credential-bearing/unsafe URLs', () => {
  for (const url of ['http://cdn.example/video', 'https://cdn.example/file?token=secret']) assert.equal(adultStreamUrl(url).href, url);
  for (const url of ['ftp://cdn.example/file', 'file:///etc/passwd', 'https://user:pass@cdn.example/file',
    'http://cdn.example:443/file', 'https://cdn.example:80/file', 'https://cdn.example:3306/file',
    'https://cdn.example/file#secret', `https://cdn.example/${'a'.repeat(4096)}`]) assert.throws(() => adultStreamUrl(url));
});

test('proxy request headers are case-normalized, bounded and allowlisted', () => {
  const result = addonRequestHeaders({ request: { 'User-Agent': 'Stremio', Referer: 'https://site.example/page',
    Origin: 'https://site.example', Cookie: 'session=SECRET', Authorization: 'Bearer SECRET', Accept: 'video/*' }, response: {} });
  assert.equal(result['user-agent'], 'Stremio'); assert.equal(result.cookie, 'session=SECRET');
  for (const request of [{ Host: 'internal' }, { 'X-Forwarded-For': '127.0.0.1' }, { Range: 'bytes=0-1' },
    { 'Content-Length': '10' }, { Connection: 'keep-alive' }, { Cookie: 'a\r\nHost: internal' },
    { Cookie: 'a\0b' }, { Authorization: 'a'.repeat(2049) }, { Referer: 'file:///private' },
    { Cookie: 'one', cookie: 'two' }, { 'User-Agent': {} }]) assert.throws(() => addonRequestHeaders({ request }));
  assert.throws(() => addonRequestHeaders({ request: { cookie: '\\'.repeat(2048), authorization: 'a' } }));
  assert.throws(() => addonRequestHeaders({ response: { 'Set-Cookie': 'SECRET' } }));
  assert.throws(() => addonRequestHeaders({ response: { 'Content-Type': 'text/html' } }));
});

test('header policies never forward credentials across host, scheme or port boundaries', () => {
  const policy = adultRequestPolicy('https://cdn.example/original', { Cookie: 'secret', Referer: 'https://site.example/page' });
  assert.equal(headersForDestination(policy, 'https://cdn.example/segment.ts').cookie, 'secret');
  for (const url of ['https://other.example/file', 'http://cdn.example/file']) assert.deepEqual(headersForDestination(policy, url), {});
  assert.deepEqual(headersForDestination(undefined, 'https://cdn.example/file'), {});
  assert.equal(adultRequestPolicy('https://cdn.example', {}), undefined);
});
