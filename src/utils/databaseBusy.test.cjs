const test = require('node:test');
const assert = require('node:assert/strict');
const { isDatabaseBusy, sendDatabaseBusy } = require('./databaseBusy.cjs');
test('pool overload returns retryable sanitized 503, without misclassifying upstream failures', () => {
  assert.equal(isDatabaseBusy({ code: 'DB_POOL_BUSY' }), true);
  assert.equal(isDatabaseBusy({ code: 'DB_POOL_UNAVAILABLE' }), true);
  assert.equal(isDatabaseBusy({ code: 'ETIMEDOUT' }), false);
  assert.equal(isDatabaseBusy({ code: 'ER_PARSE_ERROR' }), false);
  const res = { setHeader(key, value) { this[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  sendDatabaseBusy(res);
  assert.equal(res.code, 503); assert.equal(res['Retry-After'], '5');
  assert.deepEqual(res.body, { error: 'Service temporarily busy. Please try again.', code: 'DATABASE_BUSY' });
});
