const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('sanitized playback log records do not alter internal error responses or database busy handling', () => {
  const logs = [];
  const context = { module: { exports: {} }, console: { error: (...args) => logs.push(args) },
    require: id => id.includes('env') ? { env: {} } : {
      isDatabaseBusy: err => err.code === 'POOL_BUSY',
      sendDatabaseBusy: res => res.status(503).json({ error: 'database busy' }),
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./errorResponse.cjs'), 'utf8'), context);
  const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const error = Object.assign(new Error('PRIVATE-JWT'), { url: 'https://user:password@example/private', body: 'PRIVATE-BODY' });
  const res = response();
  context.module.exports.sendInternalError({}, res, 'playback/hls', error,
    { logRecord: { request_id: 'safe-id', message: 'playback internal failure' } });
  assert.equal(res.code, 500); assert.equal(res.body.error, 'internal error');
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|password|https/);
  assert.equal(error.message, 'PRIVATE-JWT');
  const busy = response();
  context.module.exports.sendInternalError({}, busy, 'playback/hls', { code: 'POOL_BUSY' }, { logRecord: {} });
  assert.equal(busy.code, 503); assert.equal(logs.length, 1);
});
