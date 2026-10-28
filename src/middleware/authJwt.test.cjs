const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('code changes invalidate old sessions; current-code sessions still use the existing active/expiry checks', async () => {
  const module = { exports: {} }; let code = 'OLD123', status = 'active', nextCalls = 0, touches = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('./authJwt.cjs'), 'utf8'), { module, console,
    require(name) {
      if (name === 'jsonwebtoken') return { verify: () => ({ device_id: 1, device_code: code }) };
      if (name === '../config/env.cjs') return { env: { JWT_SECRET: 'test' } };
      if (name === '../db/pool.cjs') return { pool: { async execute(sql) {
        if (sql.trim().startsWith('UPDATE')) { touches++; return [{}]; }
        return [[{ device_code: 'NEW456', status, platform: 'android', max_streams: 1 }]];
      } } };
      throw new Error(name);
    },
  });
  const request = async () => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports.authJwt({ headers: { authorization: 'Bearer fixture' } }, res, () => { nextCalls++; }); return res;
  };
  assert.equal((await request()).code, 401); assert.equal(nextCalls, 0); assert.equal(touches, 0);
  code = 'new456'; assert.equal((await request()).code, 200); assert.equal(nextCalls, 1); assert.equal(touches, 1);
  status = 'suspended'; assert.equal((await request()).code, 403); assert.equal(nextCalls, 1);
});

test('playlist activations cannot access provider catalogs, playback, metadata, or paid media even with an older unscoped token', async () => {
  const module = { exports: {} };
  let mode = 'playlist', claim = false, passed;
  vm.runInNewContext(fs.readFileSync(require.resolve('./authJwt.cjs'), 'utf8'), { module, console,
    require(name) {
      if (name === 'jsonwebtoken') return { verify: () => ({ device_id: 1, device_code: 'ABC123', playlist_only: claim }) };
      if (name === '../config/env.cjs') return { env: { JWT_SECRET: 'test' } };
      if (name === '../db/pool.cjs') return { pool: { execute: async sql => sql.trim().startsWith('UPDATE') ? [{}]
        : [[{ device_code: 'ABC123', status: 'active', activation_mode: mode }]] } };
      throw new Error(name);
    },
  });
  const request = async path => {
    passed = undefined;
    const req = { headers: { authorization: 'Bearer fixture' }, originalUrl: `/v1${path}`, path: '/' };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports.authJwt(req, res, () => { passed = req.device; });
    return res;
  };
  for (const path of ['/catalog/home', '/playlist.m3u8', '/playback/token', '/movies/catalog', '/adult/catalog', '/sports/events']) {
    assert.equal((await request(path)).code, 403); assert.equal(passed, undefined);
  }
  for (const path of ['/device/profile', '/device/heartbeat', '/device/movie-settings', '/live/favorites?limit=10', '/notifications']) {
    assert.equal((await request(path)).code, 200); assert.equal(passed.playlist_only, true);
  }
  mode = 'provider'; claim = true;
  assert.equal((await request('/catalog/home')).code, 403);
  claim = false;
  assert.equal((await request('/catalog/home')).code, 200); assert.equal(passed.playlist_only, false);
});
