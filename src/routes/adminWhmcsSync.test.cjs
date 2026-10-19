const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture({ owner = 2, status = 'active', claimRows = 1, serviceFound = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.post("/devices/:code/whmcs-sync",');
  const end = source.indexOf('\n/**', start);
  const queries = [], fetched = [], access = [];
  const device = { id: 10, device_code: 'FIX123', reseller_admin_id: owner, status, whmcs_service_id: 100 };
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    adminAuth() {}, router: { post(_path, _auth, callback) { handler = callback; } },
    pool: { async execute(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('UPDATE devices SET reseller_admin_id')) {
        if (claimRows) device.reseller_admin_id = params[0];
        return [{ affectedRows: claimRows }];
      }
      if (sql.trim().startsWith('SELECT')) return [[device]];
      return [{ affectedRows: 1 }];
    } },
    fetchWhmcsServiceById: async id => { fetched.push(id); return serviceFound ? { raw: { productname: 'Premium no XXX' }, service_id: id, client_id: 50, status: 'Active', next_due_date: '2026-11-01' } : null; },
    extractWhmcsPlanName: raw => raw.productname,
    syncWhmcsPlanAccess: async (...args) => access.push(args),
    extractWhmcsUpstreamCredentials: () => null,
    fetchWhmcsClientProfileById: async () => ({ name: 'Fixture Client', phone: '123', accountNumber: 'ACC-1' }),
    isSchemaMismatch: () => false,
    sendInternalError: (_req, res) => res.status(500).json({ error: 'Internal error' }),
  });
  return { queries, fetched, access, async sync(body = {}, actor = { id: 2, role: 'reseller' }) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { code: 'FIX123' }, body, admin: actor }, res); return res;
  } };
}
test('resellers can sync their own device and retain plan access updates', async () => {
  const { sync, fetched, access } = fixture();
  const result = await sync({ whmcs_service_id: 1965 });
  assert.equal(result.code, 200); assert.deepEqual(fetched, [1965]);
  assert.equal(result.body.whmcs.service_id, 1965);
  assert.deepEqual(access.map(value => Array.from(value)), [[10, 'Premium no XXX']]);
});
test('other reseller devices and unassigned active devices are denied before contacting WHMCS', async () => {
  for (const owner of [3, null]) {
    const { sync, fetched, queries } = fixture({ owner });
    assert.equal((await sync({ whmcs_service_id: 1965, reseller_admin_id: 2 })).code, 403);
    assert.deepEqual(fetched, []); assert.equal(queries.some(value => value.sql.startsWith('UPDATE')), false);
  }
});
test('pending devices are atomically assigned to the syncing reseller', async () => {
  const { sync, queries } = fixture({ owner: null, status: 'pending' });
  const result = await sync({ whmcs_service_id: 1965 });
  assert.equal(result.code, 200); assert.equal(result.body.device.reseller_admin_id, 2);
  const claim = queries.find(value => value.sql.startsWith('UPDATE devices SET reseller_admin_id'));
  assert.match(claim.sql, /reseller_admin_id IS NULL AND status='pending'/);
  assert.deepEqual(Array.from(claim.params), [2, 10]);
});
test('a lost pending-device claim does not sync metadata or plan access', async () => {
  const { sync, access, queries } = fixture({ owner: null, status: 'pending', claimRows: 0 });
  assert.equal((await sync({ whmcs_service_id: 1965 })).code, 409);
  assert.equal(access.length, 0);
  assert.equal(queries.filter(value => value.sql.trim().startsWith('UPDATE')).length, 1);
});
test('missing WHMCS service does not claim an unassigned device', async () => {
  const { sync, queries } = fixture({ owner: null, status: 'pending', serviceFound: false });
  assert.equal((await sync({ whmcs_service_id: 1965 })).code, 404);
  assert.equal(queries.some(value => value.sql.startsWith('UPDATE')), false);
});
test('invalid IDs and unauthorized roles cannot invoke WHMCS', async () => {
  for (const whmcs_service_id of [-1, 1.5, true, {}, [], 'bad', Number.MAX_SAFE_INTEGER + 1]) {
    const { sync, fetched } = fixture(); assert.equal((await sync({ whmcs_service_id })).code, 400); assert.deepEqual(fetched, []);
  }
  const { sync, fetched } = fixture();
  assert.equal((await sync({}, { id: 2, role: 'viewer' })).code, 403); assert.deepEqual(fetched, []);
});
test('super admins retain cross-device sync and stored service-ID fallback', async () => {
  const { sync, fetched } = fixture({ owner: 3 });
  assert.equal((await sync({}, { id: 1, role: 'super_admin' })).code, 200);
  assert.deepEqual(fetched, [100]);
});
