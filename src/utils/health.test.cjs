const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthHandler } = require('./health.cjs');

function response() {
  return { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('health reports the release captured at startup and verifies database readiness', async () => {
  const queries = [];
  const handler = createHealthHandler({ pool: { execute: async sql => { queries.push(sql); } }, release: 'release-a' });
  const res = response(); await handler({}, res);
  assert.deepEqual(queries, ['SELECT 1']);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, { ok: true, service: '758streamin API', release: 'release-a' });
});

test('health fails closed on a database error without exposing details', async () => {
  const handler = createHealthHandler({ pool: { execute: async () => { throw new Error('secret database details'); } }, release: 'release-b' });
  const res = response(); await handler({}, res);
  assert.equal(res.code, 503);
  assert.deepEqual(res.body, { ok: false, service: '758streamin API', release: 'release-b' });
});

test('health has a bounded response time even if its database query stalls', async () => {
  const handler = createHealthHandler({ pool: { execute: () => new Promise(() => {}) }, release: 'release-c', timeoutMs: 10 });
  const res = response(); await handler({}, res);
  assert.equal(res.code, 503);
});
