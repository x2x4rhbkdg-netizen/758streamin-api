const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupDeviceTransfers } = require('./deviceTransferCleanup.cjs');
function fixture() {
  const devices = new Map([
    [1, { id: 1, device_code: 'NEW456', device_uuid: 'new', status: 'active', plan_name: 'Premium' }],
    [2, { id: 2, device_code: 'OLD123', device_uuid: 'old', status: 'pending', reseller_admin_id: null }],
    [3, { id: 3, device_code: 'LATER1', device_uuid: 'later', status: 'pending' }],
  ]);
  const jobs = new Map([[2, { retained_device_id: 2, active_device_id: 1, retained_code: 'OLD123', retained_uuid: 'old', due: true }],
    [3, { retained_device_id: 3, active_device_id: 1, retained_code: 'LATER1', retained_uuid: 'later', due: false }]]);
  let released = false, snapshot, jobSnapshot, fail = false;
  const calls = [];
  const connection = {
    async beginTransaction() { snapshot = structuredClone(devices); jobSnapshot = structuredClone(jobs); }, async commit() {},
    async rollback() { devices.clear(); for (const [id, row] of snapshot) devices.set(id, row); jobs.clear(); for (const [id, job] of jobSnapshot) jobs.set(id, job); },
    release() { released = true; },
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM device_code_transfers')) { assert.match(sql, /delete_after<=UTC_TIMESTAMP\(\)/); return [[...jobs.values()].filter(job => job.due)]; }
      if (sql.startsWith('SELECT * FROM devices')) return [[devices.get(params[0])].filter(Boolean)];
      if (sql.startsWith('SELECT * FROM device_access')) return [[{ device_id: params[0], max_streams: 1 }]];
      if (sql.startsWith('SELECT device_id FROM')) return [[]];
      if (sql.startsWith('DELETE FROM devices')) { if (fail) throw new Error('database failed'); devices.delete(params[0]); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('DELETE FROM device_code_transfers')) { jobs.delete(params[0]); return [{}]; }
      throw new Error(sql);
    },
  };
  return { devices, jobs, calls, setFailure: () => { fail = true; }, get released() { return released; }, cleanup: () => cleanupDeviceTransfers({ getConnection: async () => connection }) };
}
test('cleanup deletes only expired retained codes, never the active new account or a not-yet-due record', async () => {
  const f = fixture(); assert.deepEqual(await f.cleanup(), { deleted: 1, preserved: 0 });
  assert.equal(f.devices.has(2), false); assert.equal(f.devices.get(1).device_code, 'NEW456'); assert.equal(f.devices.has(3), true);
  assert.equal(f.jobs.has(2), false); assert.equal(f.jobs.has(3), true); assert.equal(f.released, true);
});
test('reactivated, reconfigured or renamed retained devices are preserved rather than deleting new work', async () => {
  for (const change of [{ status: 'active' }, { customer_name: 'Reused' }, { device_code: 'NEWNEW' }, { device_uuid: 'rebound' }]) {
    const f = fixture(); Object.assign(f.devices.get(2), change);
    assert.deepEqual(await f.cleanup(), { deleted: 0, preserved: 1 }); assert.equal(f.devices.has(2), true); assert.equal(f.jobs.has(2), false);
  }
});
test('even a corrupt retention job cannot delete its active account', async () => {
  const f = fixture(); f.jobs.get(2).active_device_id = 2;
  assert.deepEqual(await f.cleanup(), { deleted: 0, preserved: 1 }); assert.equal(f.devices.has(2), true);
});
test('cleanup failure rolls back and releases locks so it can retry later', async () => {
  const f = fixture(); f.setFailure(); await assert.rejects(f.cleanup(), /database failed/);
  assert.equal(f.devices.has(2), true); assert.equal(f.jobs.has(2), true); assert.equal(f.released, true);
});
test('a later transfer leaves its newly retained code on its own new 24-hour schedule', async () => {
  const f = fixture(); await f.cleanup();
  f.jobs.get(3).due = true; await f.cleanup();
  assert.equal(f.devices.has(3), false); assert.equal(f.devices.has(1), true);
});
