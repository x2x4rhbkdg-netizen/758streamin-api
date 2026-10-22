const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(initial = 'enc:1234') {
  let encrypted = initial;
  let race = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./device.routes.cjs'), 'utf8'), {
    module, Buffer, require(name) {
      if (name === '../db/pool.cjs') return { pool: { execute: async (sql, values) => {
        if (sql.includes('SELECT adult_pin_enc')) return [[{ adult_pin_enc: encrypted }]];
        if (sql.includes('INSERT INTO device_access')) return [{ affectedRows: 0 }];
        if (sql.includes('SET adult_pin_enc=NULL')) {
          if (race || encrypted !== values[1]) return [{ affectedRows: 0 }];
          encrypted = null; return [{ affectedRows: 1 }];
        }
        if (sql.includes('SET adult_pin_enc=?')) {
          if (race || encrypted !== values[2]) return [{ affectedRows: 0 }];
          encrypted = values[0]; return [{ affectedRows: 1 }];
        }
        throw new Error('Unexpected SQL');
      } } };
      if (name.includes('authJwt')) return { authJwt: (_req, _res, next) => next() };
      if (name.includes('cryptoVault')) return {
        encryptString: pin => `enc:${pin}`, decryptString: value => value.slice(4),
      };
      if (name.includes('movieSettings')) return {};
      if (name.includes('errorResponse')) return { sendInternalError: (_req, res) => res.status(500).json({ error: 'Internal error' }) };
      if (name.includes('config/env')) return { env: {} };
      return require(name);
    },
  });
  async function invoke(action, body = {}, device = 1) {
    const route = module.exports.stack.find(layer => layer.route?.path === `/device/adult/${action}`).route;
    const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    const req = { body, device: { device_id: device } };
    for (const layer of route.stack) {
      let next = false;
      await layer.handle(req, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  }
  return { invoke, pin: () => encrypted, race: () => { race = true; } };
}

test('device PIN replacement and reset require the existing PIN', async () => {
  const f = fixture();
  assert.equal((await f.invoke('set', { pin: '5678' })).code, 403);
  assert.equal((await f.invoke('reset')).code, 403);
  assert.equal((await f.invoke('reset', { current_pin: '9999' })).code, 403);
  assert.equal(f.pin(), 'enc:1234');
  assert.equal((await f.invoke('set', { pin: '5678', current_pin: '1234' })).code, 200);
  assert.equal((await f.invoke('reset', { current_pin: '5678' })).code, 200);
  assert.equal(f.pin(), null);
});

test('initial setup works but concurrent PIN changes cannot be overwritten', async () => {
  const f = fixture(null);
  assert.equal((await f.invoke('set', { pin: '1234' })).code, 200);
  f.race();
  assert.equal((await f.invoke('set', { pin: '5678', current_pin: '1234' })).code, 409);
  assert.equal((await f.invoke('reset', { current_pin: '1234' })).code, 409);
  assert.equal(f.pin(), 'enc:1234');
});

test('PIN verification, reset and replacement share a per-device attempt limit', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.invoke(i % 2 ? 'reset' : 'verify', { pin: '9999', current_pin: '9999' })).code, 403);
  }
  assert.equal((await f.invoke('set', { pin: '5678', current_pin: '1234' })).code, 429);
  assert.equal((await f.invoke('verify', { pin: '1234' }, 2)).code, 200);
});
