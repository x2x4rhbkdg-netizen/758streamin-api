const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./playback.routes.cjs'), 'utf8');
function fixture(configured = '') {
  const context = vm.createContext({ URL, env: { PLAYBACK_BASE_URL: configured } });
  const start = source.indexOf('function normalizeBaseUrl(');
  const end = source.indexOf('\nfunction normalizeLiveOutput(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return req => context.getPlaybackBaseUrl(req);
}

for (const headers of [
  { host: 'api.758streamin.com' },
  { host: 'api.758streamin.com', 'x-forwarded-proto': 'http' },
  { host: 'api.758streamin.com', 'x-forwarded-proto': 'https, http' },
  { 'x-forwarded-host': 'api.758streamin.com', 'x-forwarded-proto': 'https' },
]) {
  test(`public playback base stays HTTPS behind a reverse proxy: ${JSON.stringify(headers)}`, () => {
    assert.equal(fixture()({ protocol: 'http', headers }), 'https://api.758streamin.com');
  });
}

test('canonical playback base takes precedence over internal or forwarded host/protocol', () => {
  const req = { protocol: 'http', headers: { host: '127.0.0.1:3000', 'x-forwarded-host': 'other.example' } };
  assert.equal(fixture('https://api.758streamin.com/')(req), 'https://api.758streamin.com');
  assert.equal(fixture('http://api.758streamin.com/')(req), 'https://api.758streamin.com');
  assert.equal(fixture('api.758streamin.com')(req), 'https://api.758streamin.com');
});

test('loopback HTTP remains available for development and fixture servers', () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'api.localhost:3000']) {
    assert.equal(fixture()({ protocol: 'http', headers: { host } }), `http://${host}`);
  }
  assert.equal(fixture('http://localhost:4000')({}), 'http://localhost:4000');
  assert.equal(fixture()({ protocol: 'https', headers: { host: 'localhost:3000' } }), 'https://localhost:3000');
});

test('missing host retains relative-link fallback and invalid configured bases fail closed', () => {
  assert.equal(fixture()({}), '');
  for (const base of ['https://user:pass@api.example', 'https://api.example/?token=private', 'https://api.example/#fragment']) {
    assert.throws(() => fixture(base)({}), /invalid playback base URL/);
  }
});
