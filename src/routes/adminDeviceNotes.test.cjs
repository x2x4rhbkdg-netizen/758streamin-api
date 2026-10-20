const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(owner = 2) {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.patch("/devices/:code",');
  const end = source.indexOf('\n/**', start);
  let handler, stored = 'Old note';
  const calls = [];
  vm.runInNewContext(source.slice(start, end), {
    adminAuth() {}, router: { patch(_path, _auth, callback) { handler = callback; } },
    pool: { async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO device_access')) { stored = params[1]; return [{ affectedRows: 1 }]; }
      if (sql.trim().startsWith('SELECT')) return [[{ id: 10, reseller_admin_id: owner, status: 'active', notes: stored }]];
      return [{ affectedRows: 1 }];
    } },
    sendInternalError: (_req, res) => res.status(500).json({ error: 'Internal error' }),
  });
  return { calls, async patch(body, admin = { id: 2, role: 'reseller' }) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { code: 'FIX123' }, body, admin }, res); return res;
  } };
}
test('device notes save multiline text and return it without changing access limits', async () => {
  const { patch, calls } = fixture();
  const result = await patch({ notes: 'First line\nSecond line' });
  assert.equal(result.code, 200); assert.equal(result.body.device.notes, 'First line\nSecond line');
  const write = calls.find(value => value.sql.includes('INSERT INTO device_access'));
  assert.deepEqual(Array.from(write.params), [10, 'First line\nSecond line']);
  assert.doesNotMatch(write.sql, /expires_at|max_streams|adult_pin/);
});
test('empty or null notes clear explicitly, while omitted notes remain untouched', async () => {
  for (const notes of ['', null]) {
    const { patch } = fixture(); assert.equal((await patch({ notes })).body.device.notes, null);
  }
  const { patch, calls } = fixture();
  assert.equal((await patch({ customer_name: 'New name' })).body.device.notes, 'Old note');
  assert.equal(calls.some(value => value.sql.includes('INSERT INTO device_access')), false);
});
test('oversized and non-text notes are rejected before writes', async () => {
  for (const notes of ['x'.repeat(4001), 123, {}, [], true]) {
    const { patch, calls } = fixture(); assert.equal((await patch({ notes })).code, 400); assert.equal(calls.length, 0);
  }
});
test('notes obey existing device ownership and super admin permissions', async () => {
  const blocked = fixture(3);
  assert.equal((await blocked.patch({ notes: 'No access' })).code, 403);
  assert.equal(blocked.calls.some(value => value.sql.includes('INSERT')), false);
  const admin = fixture(3);
  assert.equal((await admin.patch({ notes: 'Admin note' }, { id: 1, role: 'super_admin' })).code, 200);
});
test('admin device listing and edit response select the existing notes column', () => {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  for (const route of ['router.get("/devices",', 'router.patch("/devices/:code",']) {
    const start = source.indexOf(route), end = source.indexOf('\nrouter.', start + 1);
    assert.match(source.slice(start, end), /a\.notes/);
  }
});
