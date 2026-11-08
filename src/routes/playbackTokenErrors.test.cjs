const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
const source = fs.readFileSync(require.resolve('./playback.routes.cjs'), 'utf8');
const secret = 'playback-expiry-test-only';
const paths = ['/playback/hls', '/playback/hls-asset', '/playback/stream', '/playback/embedded-hls', '/playback/embedded-hls-asset'];
function fixture() {
  const handlers = new Map();
  const state = { reads: 0, serverErrors: 0, row: { status: 'active', platform: 'android_tv', upstream_device_id: 7 }, dbFailure: false };
  const context = vm.createContext({ jwt, env: { JWT_SECRET: secret }, PLAYBACK_AUD: 'playback', PLAYBACK_ISS: 'streamin-api',
    pool: { async execute() {
      state.reads++; if (state.dbFailure) throw new Error('database failure');
      return [state.row ? [state.row] : []];
    } },
    resolveDeviceUpstreamRow: row => row ? { upstream_base_url: 'https://upstream.example' } : null,
    router: { get: (path, handler) => handlers.set(path, handler) },
    hashPlaybackToken: () => 'fixture-hash', logPlaybackDebug() {}, summarizeUrlForLog: () => '', isHttpUrl: () => true,
    sendInternalError(_req, res) { state.serverErrors++; return res.status(500).json({ error: 'internal error' }); },
  });
  const start = source.indexOf('async function resolvePlaybackContext(');
  vm.runInContext(source.slice(start, source.indexOf('\nfunction getPlaybackTokenExpiresAtMs', start)), context);
  for (const path of paths) {
    const start = source.indexOf(`router.get("${path}"`);
    const next = source.indexOf('\nrouter.get(', start + 1);
    const end = next < 0 ? source.indexOf('\nmodule.exports', start) : next;
    vm.runInContext(source.slice(start, end), context);
  }
  return { state, context, async request(path, token) {
    const res = { headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get(path)({ query: { token, asset: 'fixture', url: 'https://upstream.example/segment.ts' } }, res);
    return res;
  } };
}
function token(options = {}, key = secret) {
  return jwt.sign({ device_id: 7 }, key, { audience: 'playback', issuer: 'streamin-api', expiresIn: 3600, ...options });
}
test('expired JWTs return quiet, non-cacheable 401 on every playback route before SQL', async () => {
  const f = fixture();
  for (const path of paths) {
    const res = await f.request(path, token({ expiresIn: -60 }));
    assert.equal(res.code, 401, path);
    assert.equal(res.body.code, 'PLAYBACK_TOKEN_EXPIRED');
    assert.equal(res.body.error, 'playback token expired');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  assert.equal(f.state.reads, 0); assert.equal(f.state.serverErrors, 0);
});
test('bad signatures, wrong audience/issuer, malformed and not-yet-valid tokens remain denied', async () => {
  const f = fixture();
  for (const value of [token({}, 'wrong-key'), token({ audience: 'wrong' }), token({ issuer: 'wrong' }), 'malformed', token({ notBefore: 3600 })]) {
    const res = await f.request('/playback/embedded-hls', value);
    assert.equal(res.code, 401);
    assert.ok(['PLAYBACK_TOKEN_INVALID', 'PLAYBACK_TOKEN_NOT_ACTIVE'].includes(res.body.code));
  }
  assert.equal(f.state.reads, 0); assert.equal(f.state.serverErrors, 0);
});
test('valid tokens still require fresh SQL authorization; deleted, suspended and expired devices are denied', async () => {
  const f = fixture();
  await f.context.resolvePlaybackContext(token()); assert.equal(f.state.reads, 1);
  for (const [row, status] of [[null, 401], [{ status: 'suspended' }, 403], [{ status: 'active', expires_at: '2000-01-01' }, 403]]) {
    f.state.row = row;
    const res = await f.request('/playback/embedded-hls', token());
    assert.equal(res.code, status); assert.equal(res.body.code, undefined);
  }
  assert.equal(f.state.reads, 4); assert.equal(f.state.serverErrors, 0);
});
test('database errors are server failures, not invalid tokens, including the redirect endpoint', async () => {
  const f = fixture(); f.state.dbFailure = true;
  for (const path of paths) assert.equal((await f.request(path, token())).code, 500);
  assert.equal(f.state.serverErrors, paths.length);
});
