const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(overrides = {}) {
  const device = { id: 1, device_uuid: 'fixture-device-uuid', device_code: 'ABC123', status: 'pending', ...overrides };
  let committed = 0, rolledBack = 0, released = 0;
  const signed = [], writes = [];
  const execute = async (sql, values) => {
    if (sql.includes('SELECT')) return [[{ ...device }]];
    writes.push({ sql, values });
    if (sql.includes('activation_mode=VALUES')) device.activation_mode = values[1];
    if (sql.includes("SET status='active'")) device.status = 'active';
    return [{ affectedRows: 1 }];
  };
  const connection = { execute, beginTransaction: async () => {}, commit: async () => { committed++; },
    rollback: async () => { rolledBack++; }, release: () => { released++; } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./device.routes.cjs'), 'utf8'), { module, console, Buffer,
    require(name) {
      if (name === '../db/pool.cjs') return { pool: { execute, getConnection: async () => connection } };
      if (name === 'jsonwebtoken') return { sign: payload => { signed.push(payload); return 'playlist-token'; } };
      if (name.includes('authJwt')) return { authJwt: (_req, _res, next) => next() };
      if (name.includes('config/env')) return { env: { JWT_SECRET: 'fixture' } };
      if (name.includes('cryptoVault')) return { encryptString: value => value, decryptString: value => value };
      if (name.includes('movieSettings')) return { publicSettings: settings => settings, readMovieSettings: async () => { throw new Error('Provider settings must not be read'); } };
      if (name.includes('errorResponse')) return { sendInternalError: (_req, res, _area, error) => res.status(500).json({ error: error.message }) };
      return require(name);
    },
  });
  async function invoke(path = '/device/activate-playlist', body = { device_uuid: device.device_uuid, device_code: device.device_code }, scope = {}) {
    const route = module.exports.stack.find(layer => layer.route?.path === path).route;
    const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    for (const layer of route.stack) {
      let next = false;
      await layer.handle({ body, device: { device_id: 1, ...scope } }, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  }
  return { device, signed, writes, invoke, get committed() { return committed; }, get rolledBack() { return rolledBack; }, get released() { return released; } };
}

test('pending device becomes dashboard-active with playlist-only credentials, including retry and token renewal', async () => {
  const f = fixture();
  assert.equal((await f.invoke()).code, 200);
  assert.equal(f.device.status, 'active'); assert.equal(f.device.activation_mode, 'playlist');
  assert.equal(f.signed[0].playlist_only, true); assert.equal(f.committed, 1); assert.equal(f.released, 1);
  assert.equal((await f.invoke()).code, 200); assert.equal(f.device.activation_mode, 'playlist');
  assert.equal((await f.invoke('/device/auth')).code, 200);
  assert.equal(f.signed.at(-1).playlist_only, true);
  assert.ok(f.writes.every(write => !write.sql.includes('device_upstream')));
});

test('playlist use does not replace an active provider subscription', async () => {
  const f = fixture({ status: 'active', activation_mode: 'provider' });
  assert.equal((await f.invoke()).code, 200);
  assert.equal(f.device.activation_mode, 'provider');
  assert.equal(f.signed[0].playlist_only, true);
});

test('wrong UUID, suspended devices and expired access cannot auto-activate', async () => {
  const mismatch = fixture();
  assert.equal((await mismatch.invoke(undefined, { device_uuid: 'different-uuid', device_code: 'ABC123' })).code, 401);
  assert.equal(mismatch.writes.length, 0); assert.equal(mismatch.rolledBack, 1);
  for (const state of [{ status: 'suspended' }, { expires_at: '2020-01-01' }, { trial_expires_at: '2020-01-01' }]) {
    const f = fixture(state);
    assert.equal((await f.invoke()).code, 403); assert.equal(f.signed.length, 0); assert.equal(f.writes.length, 0);
  }
});

test('playlist settings expose only the local Live TV feature, never provider metadata or secrets', async () => {
  const f = fixture();
  const res = await f.invoke('/device/movie-settings', {}, { playlist_only: true });
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { live_tv_enabled: true, radio_enabled: false,
    enabled: false, anime_enabled: false, adult_enabled: false, sports_enabled: false });
});
