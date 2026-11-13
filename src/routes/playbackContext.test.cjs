const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('playback context uses one joined read per request while retaining deletion, status and expiry checks', async () => {
  const text = fs.readFileSync(require.resolve('./playback.routes.cjs'), 'utf8');
  const start = text.indexOf('async function resolvePlaybackContext(');
  const end = text.indexOf('\nfunction getPlaybackTokenExpiresAtMs', start);
  let device = { status: 'active', platform: 'android', upstream_device_id: 7, enc_username: 'encrypted' };
  let reads = 0, resolves = 0, invalidToken = false;
  const context = { env: { JWT_SECRET: 'fixture' }, PLAYBACK_AUD: 'playback', PLAYBACK_ISS: 'streamin-api',
    playbackLogging: { identify() {} },
    jwt: { verify() { if (invalidToken) throw new Error('expired token'); return { device_id: 7 }; } },
    pool: { async execute(sql, params) {
      reads++; assert.match(sql, /LEFT JOIN device_upstream/); assert.match(sql, /WHERE d.id=\?/);
      assert.deepEqual(Array.from(params), [7]); return [device ? [device] : []];
    } },
    resolveDeviceUpstreamRow(row) { resolves++; return row ? { username: 'fixture' } : null; },
  };
  vm.createContext(context); vm.runInContext(text.slice(start, end), context);
  assert.equal((await context.resolvePlaybackContext('token')).upstream.username, 'fixture');
  assert.equal(reads, 1); assert.equal(resolves, 1);
  device = null;
  await assert.rejects(context.resolvePlaybackContext('token'), error => error.status === 401);
  device = { status: 'suspended' };
  await assert.rejects(context.resolvePlaybackContext('token'), error => error.status === 403);
  device = { status: 'active', expires_at: '2000-01-01' };
  await assert.rejects(context.resolvePlaybackContext('token'), error => error.status === 403);
  assert.equal(resolves, 1);
  device = { status: 'active' };
  await assert.rejects(context.resolvePlaybackContext('token'), error => error.status === 404);
  const previousReads = reads; invalidToken = true;
  await assert.rejects(context.resolvePlaybackContext('token'));
  assert.equal(reads, previousReads);
});
