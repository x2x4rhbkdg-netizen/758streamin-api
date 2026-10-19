const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(device = { id: 10, reseller_admin_id: 2, status: 'active' }) {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.patch("/devices/:code",');
  const end = source.indexOf('\n/**', start);
  let handler;
  const calls = [];
  vm.runInNewContext(source.slice(start, end), {
    adminAuth() {}, router: { patch(_path, _auth, callback) { handler = callback; } },
    pool: { async execute(sql, params) {
      calls.push({ sql, params });
      return sql.trim().startsWith('SELECT') ? [[device]] : [{ affectedRows: 1 }];
    } },
    toMysqlDatetime: value => value, toMysqlDateOnly: value => value,
    normalizeWhmcsStatus: value => String(value).toLowerCase(),
    sendInternalError: (_req, res) => res.status(500).json({ error: 'Internal error' }),
  });
  return { calls, async patch(body, actor = { id: 2, role: 'reseller' }) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { code: 'FIX123' }, body, admin: actor }, res); return res;
  } };
}
test('resellers can save the WHMCS service ID for their own device', async () => {
  const { calls, patch } = fixture();
  assert.equal((await patch({ whmcs_service_id: 1965 })).code, 200);
  const update = calls.find(call => call.sql.startsWith('UPDATE'));
  assert.match(update.sql, /whmcs_service_id=\?/); assert.deepEqual(Array.from(update.params), [1965, 10]);
});
test('reseller edits do not grant access to WHMCS client, billing, dates or assignment', async () => {
  const { calls, patch } = fixture();
  assert.equal((await patch({ whmcs_service_id: '1965', whmcs_client_id: 999, whmcs_billing_status: 'Active',
    whmcs_next_due_date: '2030-01-01', whmcs_last_sync_at: '2030-01-01', reseller_admin_id: 99 })).code, 200);
  const update = calls.find(call => call.sql.startsWith('UPDATE'));
  assert.doesNotMatch(update.sql, /whmcs_client_id|whmcs_billing_status|whmcs_next_due_date|whmcs_last_sync_at|reseller_admin_id/);
  assert.deepEqual(Array.from(update.params), [1965, 10]);
  assert.equal((await fixture().patch({ whmcs_client_id: 999 })).code, 400);
});
test('resellers cannot edit another reseller device or an unassigned active device', async () => {
  for (const reseller_admin_id of [3, null]) {
    const { calls, patch } = fixture({ id: 10, reseller_admin_id, status: 'active' });
    assert.equal((await patch({ whmcs_service_id: 1965 })).code, 403);
    assert.equal(calls.some(call => call.sql.startsWith('UPDATE')), false);
  }
});
test('pending unassigned devices retain existing reseller auto-assignment when saving a service ID', async () => {
  const { calls, patch } = fixture({ id: 10, reseller_admin_id: null, status: 'pending' });
  assert.equal((await patch({ whmcs_service_id: 1965 })).code, 200);
  const update = calls.find(call => call.sql.startsWith('UPDATE'));
  assert.match(update.sql, /reseller_admin_id=\?.*whmcs_service_id=\?/);
  assert.deepEqual(Array.from(update.params), [2, 1965, 10]);
});
test('invalid service IDs are rejected without database writes', async () => {
  for (const whmcs_service_id of [-1, 0, 1.5, 'abc', true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const { calls, patch } = fixture();
    assert.equal((await patch({ whmcs_service_id })).code, 400);
    assert.equal(calls.some(call => call.sql.startsWith('UPDATE')), false);
  }
});
test('clearing the service ID is explicit; omitted IDs stay unchanged', async () => {
  const clear = fixture();
  assert.equal((await clear.patch({ whmcs_service_id: null })).code, 200);
  assert.equal(clear.calls.find(call => call.sql.startsWith('UPDATE')).params[0], null);
  const preserve = fixture();
  assert.equal((await preserve.patch({ customer_name: 'Updated' })).code, 200);
  assert.doesNotMatch(preserve.calls.find(call => call.sql.startsWith('UPDATE')).sql, /whmcs_service_id/);
});
test('super admins retain other WHMCS edit permissions', async () => {
  const { calls, patch } = fixture();
  assert.equal((await patch({ whmcs_service_id: 1965, whmcs_client_id: 1396, whmcs_billing_status: 'Active' }, { id: 1, role: 'super_admin' })).code, 200);
  assert.match(calls.find(call => call.sql.startsWith('UPDATE')).sql, /whmcs_client_id=\?.*whmcs_service_id=\?.*whmcs_billing_status=\?/);
});
