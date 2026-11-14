const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ authorized = true, found = true, fail = false, deviceFound = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'admin.whmcsReminders.routes.cjs'), 'utf8');
  const start = source.indexOf('router.post("/whmcs/payments/auto",');
  const end = source.indexOf('\nrouter.', start + 1);
  const device = { id: 42, whmcs_service_id: 9, trial_expires_at: '2026-01-01', status: 'active' };
  const queries = [];
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    router: { post(_route, callback) { handler = callback; } },
    requireAutomationSecret: (_req, res) => { if (!authorized) res.status(403).json({ error: 'forbidden' }); return authorized; },
    pool: { async execute(sql) {
      queries.push(sql);
      if (sql.includes('UPDATE devices') && sql.includes('trial_expires_at=NULL')) device.trial_expires_at = null;
      return [[...(deviceFound ? [{ ...device }] : [])]];
    } },
    fetchWhmcsServiceById: async () => {
      if (fail) throw new Error('WHMCS unavailable');
      return found ? { raw: {}, service_id: 9, client_id: 3, status: 'Active' } : null;
    },
    extractWhmcsPlanName: () => 'Premium', syncWhmcsPlanAccess: async () => {},
    isSchemaMismatch: () => false,
    sendInternalError: (_req, res) => res.status(500).json({ error: 'unavailable' }),
  });
  return { device, queries, async run() {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { device_code: 'TEST42' }, query: {} }, res);
    return res;
  } };
}

test('verified payment callback clears trial expiry and includes null in its response', async () => {
  const item = fixture();
  const result = await item.run();
  assert.equal(result.code, 200);
  assert.equal(result.body.device.trial_expires_at, null);
  assert.ok(item.queries.some(sql => sql.includes('d.trial_expires_at')));
  assert.equal(item.queries.filter(sql => sql.includes('UPDATE devices')).length, 1);
});

test('unauthorized, missing, deleted and failed WHMCS lookups never clear a trial', async () => {
  for (const [options, code] of [[{ authorized: false }, 403], [{ found: false }, 404],
    [{ deviceFound: false }, 404], [{ fail: true }, 500]]) {
    const item = fixture(options);
    assert.equal((await item.run()).code, code);
    assert.equal(item.device.trial_expires_at, '2026-01-01');
    assert.equal(item.queries.some(sql => sql.includes('UPDATE devices')), false);
  }
});
