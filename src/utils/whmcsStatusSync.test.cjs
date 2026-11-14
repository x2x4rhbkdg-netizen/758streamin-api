const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhmcsStatusSync, fetchServiceStatuses, matchingDeviceStatus } = require('./whmcsStatusSync.cjs');
const env = { WHMCS_API_URL: 'https://billing.example/api', WHMCS_API_IDENTIFIER: 'test', WHMCS_API_SECRET: 'fixture' };
const response = data => ({ ok: true, json: async () => ({ result: 'success', ...data }) });

test('only authoritative Active and Suspended map to device status', () => {
  for (const value of ['Active', ' ACTIVE ']) assert.equal(matchingDeviceStatus(value), 'active');
  assert.equal(matchingDeviceStatus('Suspended'), 'suspended');
  for (const value of [null, '', 'Pending', 'Terminated', 'Cancelled', 'error']) assert.equal(matchingDeviceStatus(value), null);
});

test('WHMCS paginates once per page and ignores unrelated service IDs and credentials', async () => {
  const requests = [];
  const statuses = await fetchServiceStatuses(env, [2, 3], async (_url, options) => {
    const query = new URLSearchParams(options.body); requests.push(query);
    return response({ totalresults: '3', products: { product: query.get('limitstart') === '0'
      ? [{ id: 1, status: 'Active', password: 'private' }, { id: 2, status: 'Suspended' }]
      : { id: 3, status: 'Active' } } });
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get('limitstart'), '2');
  assert.equal(requests[0].get('serviceid'), null);
  assert.deepEqual([...statuses], [['2', 'suspended'], ['3', 'active']]);
});

function fixture() {
  const state = { locked: false, due: true, reads: 0, writes: [], releases: 0, fetches: 0, fail: false, lease: '2030-01-01 00:00:00' };
  const execute = async (sql, params) => {
      if (sql.includes('GET_LOCK')) {
        if (state.locked) return [[{ acquired: 0 }]];
        state.locked = true; return [[{ acquired: 1 }]];
      }
      if (sql.includes('RELEASE_LOCK')) { state.locked = false; return [[{ released: 1 }]]; }
      if (sql.includes('WHERE job_name=? AND next_run_at<=UTC_TIMESTAMP()')) {
        const affectedRows = state.due ? 1 : 0; state.due = false; return [{ affectedRows }];
      }
      if (sql.includes('DATE_FORMAT')) return [[{ lease: state.lease }]];
      if (sql.includes('SELECT DISTINCT')) { state.reads++; return [[{ whmcs_service_id: 10 }, { whmcs_service_id: 20 }]]; }
      if (sql.startsWith('UPDATE devices')) {
        if (params.at(-1) !== state.lease) return [{ affectedRows: 0 }];
        state.writes.push({ sql, params }); return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    };
  const pool = { execute, async getConnection() { return { execute, release() { state.releases++; } }; } };
  const options = { pool, env, logger: { warn() {} }, fetcher: async () => {
    assert.equal(state.locked, false, 'HTTP must not hold the advisory lock');
    assert.ok(state.releases > 0, 'HTTP must not retain its checked-out connection');
    state.fetches++; if (state.fail) throw new Error('Transport failed');
    return response({ totalresults: 2, products: { product: [{ id: 10, status: 'Active' }, { id: 20, status: 'Suspended' }] } });
  } };
  return { state, options };
}

test('workers share a durable due slot; verified services clear local trials but preserve other access', async () => {
  const { state, options } = fixture();
  const a = createWhmcsStatusSync(options), b = createWhmcsStatusSync(options);
  await Promise.all([a.run(), a.run(), b.run()]);
  await b.run();
  assert.equal(state.reads, 1); assert.equal(state.fetches, 1);
  assert.equal(state.writes.length, 2); assert.equal(state.locked, false);
  for (const { sql, params } of state.writes) {
    assert.match(sql, /whmcs_service_id IN \(\?\)/);
    assert.match(sql, /status IN \('active', 'suspended'\)/);
    assert.match(sql, /whmcs_billing_status <=>/);
    assert.match(sql, /trial_expires_at=NULL/);
    assert.match(sql, /OR trial_expires_at IS NOT NULL/);
    assert.doesNotMatch(sql.replaceAll('trial_expires_at', ''), /plan_name|device_access|expires_at|upstream|DELETE|device_code/);
    assert.equal(params[0], params.at(-4));
    assert.match(sql, /next_run_at=\? AND next_run_at>UTC_TIMESTAMP/);
  }
});

test('failed WHMCS responses never change device states and release the worker lock', async () => {
  const { state, options } = fixture(); state.fail = true;
  await assert.rejects(createWhmcsStatusSync(options).run());
  assert.equal(state.writes.length, 0); assert.equal(state.locked, false); assert.equal(state.releases, 1);
});

test('no configured WHMCS means no database connection or status change', async () => {
  const { state, options } = fixture();
  assert.deepEqual(await createWhmcsStatusSync({ ...options, env: {} }).run(), { skipped: true });
  assert.equal(state.releases, 0); assert.equal(state.fetches, 0);
});

test('a superseded WHMCS worker cannot write device states after its HTTP response', async () => {
  const { state, options } = fixture();
  const fetcher = options.fetcher;
  options.fetcher = async (...args) => {
    const response = await fetcher(...args);
    state.lease = '2030-01-01 00:05:00';
    return response;
  };
  const result = await createWhmcsStatusSync(options).run();
  assert.equal(result.changed, 0); assert.equal(state.writes.length, 0);
});
