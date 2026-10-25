const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDeviceCode, replaceDeviceCode } = require('./replaceDeviceCode.cjs');
function fixture({ target = {}, children = {}, failure = false } = {}) {
  const devices = new Map([
    [1, { id: 1, device_code: 'OLD123', device_uuid: 'old-uuid', status: 'active', reseller_admin_id: 2, customer_name: 'Customer', plan_name: 'Premium', platform: 'android', model: 'Old TV' }],
    [2, { id: 2, device_code: 'NEW456', device_uuid: 'new-uuid', status: 'pending', reseller_admin_id: null, platform: 'android', model: 'New TV', ...target }],
  ]);
  const account = { expires_at: '2027-01-01', max_streams: 3, adult_pin_enc: 'retained-pin', notes: 'retained-notes' };
  const jobs = new Map();
  const calls = []; let snapshot, jobSnapshot, released = false, committed = false;
  const connection = {
    async beginTransaction() { snapshot = structuredClone(devices); jobSnapshot = structuredClone(jobs); },
    async commit() { committed = true; },
    async rollback() { devices.clear(); for (const [id, row] of snapshot) devices.set(id, row); jobs.clear(); for (const [id, row] of jobSnapshot) jobs.set(id, row); },
    release() { released = true; },
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM devices')) return [[...devices.values()].filter(row => params.includes(row.device_code))];
      if (sql.startsWith('DELETE FROM device_code_transfers')) { jobs.delete(params[0]); return [{}]; }
      if (sql.startsWith('INSERT INTO device_code_transfers')) { jobs.set(params[0], [...params]); return [{}]; }
      if (sql.startsWith('INSERT INTO devices')) {
        const id = 3; devices.set(id, { id, device_uuid: params[0], device_code: params[1], status: 'pending', platform: params[2], model: params[3], app_version: params[4], reseller_admin_id: params[5] });
        return [{ insertId: id }];
      }
      if (sql.startsWith('SELECT * FROM device_access')) return [[{ device_id: params[0], max_streams: 1, ...children.access }]];
      if (sql.startsWith('SELECT device_id FROM')) {
        const table = sql.match(/FROM (\w+)/)[1];
        if (children[table] instanceof Error) throw children[table];
        return [children[table] ? [{ device_id: params[0] }] : []];
      }
      if (sql.startsWith('UPDATE devices')) {
        const id = params.at(-1), row = devices.get(id);
        if (failure && params.length === 7 && id === 1) throw new Error('write failed');
        if (params.length === 2) row.device_code = params[0];
        else if (params.length === 3) { row.device_uuid = params[0]; row.device_code = params[1]; }
        else [row.device_uuid, row.device_code, row.platform, row.model, row.app_version, row.last_seen_at] = params;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { devices, account, jobs, calls, get released() { return released; }, get committed() { return committed; },
    change: (newCode = 'NEW456', admin = { id: 2, role: 'reseller' }) => replaceDeviceCode({ db: { getConnection: async () => connection }, admin, code: 'OLD123', newCode,
      encrypt: value => Buffer.from(value).toString('base64') }) };
}
test('codes normalize letters and reject empty, oversized or unsafe values', () => {
  assert.equal(normalizeDeviceCode(' new456 '), 'NEW456');
  for (const value of ['', 'a', 'abc 123', 'abc-123', 'x'.repeat(33), null, 123456]) assert.throws(() => normalizeDeviceCode(value), { status: 400 });
});
test('fresh pending identity transfers to the existing account without deleting either device or account data', async () => {
  const f = fixture();
  const result = await f.change('new456');
  assert.equal(result.device_id, 1); assert.equal(result.transferred, true);
  assert.equal(f.devices.size, 2);
  assert.equal(f.devices.get(1).device_code, 'NEW456');
  assert.equal(f.devices.get(1).device_uuid, 'new-uuid');
  assert.equal(f.devices.get(1).model, 'New TV');
  assert.equal(f.devices.get(1).customer_name, 'Customer');
  assert.equal(f.devices.get(1).plan_name, 'Premium');
  assert.equal(f.devices.get(1).reseller_admin_id, 2);
  assert.equal(f.devices.get(2).device_code, 'OLD123');
  assert.equal(f.devices.get(2).device_uuid, 'old-uuid');
  assert.equal(f.devices.get(2).status, 'pending');
  assert.equal(f.devices.get(2).model, 'Old TV');
  assert.equal(f.account.adult_pin_enc, 'retained-pin');
  assert.equal(f.calls.some(call => /DELETE FROM devices|UPDATE device_access|UPDATE device_upstream/.test(call.sql)), false);
  assert.equal(result.retention_hours, 24); assert.equal(f.jobs.get(2)[1], 1); assert.equal(f.jobs.get(2)[2], 'OLD123');
  assert.match(f.calls.find(call => call.sql.startsWith('INSERT INTO device_code_transfers')).sql, /INTERVAL 24 HOUR/);
  assert.equal(JSON.parse(Buffer.from(f.jobs.get(2)[4], 'base64').toString()).customer_name, 'Customer');
  assert.equal(f.committed, true); assert.equal(f.released, true);
});
test('unused code renames only the existing record; unchanged code is a no-op', async () => {
  const f = fixture(); await f.change('FREE789');
  assert.equal(f.devices.get(1).device_uuid, 'old-uuid');
  assert.equal(f.devices.get(1).device_code, 'FREE789');
  assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE')).length, 1);
  assert.equal(f.devices.get(3).device_code, 'OLD123'); assert.equal(f.jobs.get(3)[1], 1);
  const same = fixture(); await same.change('old123');
  assert.equal(same.calls.some(call => call.sql.startsWith('UPDATE')), false);
});
test('resellers cannot change another account; super admins may change it', async () => {
  const f = fixture(); await assert.rejects(f.change('NEW456', { id: 3, role: 'reseller' }), { status: 403 });
  assert.equal(f.calls.some(call => call.sql.startsWith('UPDATE')), false); assert.equal(f.released, true);
  await fixture().change('NEW456', { id: 1, role: 'super_admin' });
});
test('configured or differently owned target devices are rejected without writes', async () => {
  for (const target of [{ status: 'active' }, { status: 'suspended' }, { reseller_admin_id: 3 }, { customer_name: 'Other customer' }, { whmcs_service_id: 99 }, { plan_name: 'Trial' }]) {
    const f = fixture({ target }); await assert.rejects(f.change(), { status: 409 });
    assert.equal(f.calls.some(call => call.sql.startsWith('UPDATE')), false);
  }
  for (const children of [{ access: { adult_pin_enc: 'pin' } }, { access: { expires_at: '2027-01-01' } }, { access: { max_streams: 2 } },
    { access: { notes: 'Owned' } }, { device_upstream: true }, { analytics_events: true }, { device_movie_settings: true }]) {
    const f = fixture({ children }); await assert.rejects(f.change(), { status: 409 });
    assert.equal(f.calls.some(call => call.sql.startsWith('UPDATE')), false);
  }
});
test('a failed identity swap rolls back both devices and always releases the connection', async () => {
  const f = fixture({ failure: true }); await assert.rejects(f.change(), /write failed/);
  assert.equal(f.devices.get(1).device_code, 'OLD123'); assert.equal(f.devices.get(2).device_code, 'NEW456');
  assert.equal(f.devices.get(1).device_uuid, 'old-uuid'); assert.equal(f.devices.get(2).device_uuid, 'new-uuid');
  assert.equal(f.committed, false); assert.equal(f.released, true);
  assert.equal(f.jobs.size, 0);
});
