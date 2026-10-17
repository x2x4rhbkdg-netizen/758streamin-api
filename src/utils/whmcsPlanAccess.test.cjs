const test = require('node:test');
const assert = require('node:assert/strict');
const { adultAccessForPlan, syncWhmcsPlanAccess } = require('./whmcsPlanAccess.cjs');

test('XXX plan marker enables Adult Content, case-insensitively', () => {
  for (const name of ['Premium XXX', 'Family + xxx', 'TV (XxX)', 'XXX']) {
    assert.equal(adultAccessForPlan(name), true, name);
  }
});

test('no XXX takes precedence even when another XXX marker exists', () => {
  for (const name of ['Premium no xxx', 'TV NO XXX', 'TV (No-XXX)', 'TV no_XXX',
    'XXX bundle - no xxx', 'TV no   xxx']) {
    assert.equal(adultAccessForPlan(name), false, name);
  }
});

test('Premium plans from WHMCS enable Adult unless explicitly No XXX', () => {
  for (const days of [30, 90, 365]) {
    for (let devices = 1; devices <= 6; devices += 1) {
      const plan = `758 StreamIN Premium ${days} days ${devices} Devices (Hidden)`;
      assert.equal(adultAccessForPlan(plan), true, plan);
      const excluded = `Premium No XXX ${days} days ${devices} Devices (Hidden)`;
      assert.equal(adultAccessForPlan(excluded), false, excluded);
    }
  }
  assert.equal(adultAccessForPlan('premium'), true);
  assert.equal(adultAccessForPlan('PREMIUM 30 days 1 Device'), true);
});

test('missing or unrelated plan names do not change manual access', async () => {
  for (const name of [null, undefined, '', 'Basic', 'PremiumExtra', 'xxxx', 'xxxtra', 'annoxxx']) {
    assert.equal(adultAccessForPlan(name), null);
    await syncWhmcsPlanAccess(42, name, () => assert.fail('Unexpected settings write'));
  }
});

test('sync changes only the Adult flag for the selected device', async () => {
  const calls = [];
  const save = async (...args) => calls.push(args);
  await syncWhmcsPlanAccess(42, 'Premium XXX', save);
  await syncWhmcsPlanAccess(43, 'Premium no XXX', save);
  await syncWhmcsPlanAccess(44, 'Premium 30 days 1 Device', save);
  assert.deepEqual(calls, [[42, { adult_enabled: true }], [43, { adult_enabled: false }],
    [44, { adult_enabled: true }]]);
});

test('persistence errors propagate instead of reporting successful sync', async () => {
  await assert.rejects(syncWhmcsPlanAccess(42, 'No XXX', async () => {
    throw new Error('storage unavailable');
  }), /storage unavailable/);
});

test('both WHMCS sync routes apply access from the fetched plan, not a stale device plan', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  for (const [file, route] of [
    ['admin.routes.cjs', '/devices/:code/whmcs-sync'],
    ['admin.whmcsReminders.routes.cjs', '/whmcs/payments/auto'],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../routes', file), 'utf8');
    const start = source.indexOf(`router.post("${route}"`);
    const end = source.indexOf('\nrouter.', start + 1);
    assert.ok(start >= 0 && end > start);
    for (const plan of ['Premium XXX', 'Premium 30 days 1 Device', 'Premium no XXX', null]) {
      let handler;
      const calls = [];
      vm.runInNewContext(source.slice(start, end), {
        router: { post(...args) { handler = args.at(-1); } },
        adminAuth() {}, requireSuperAdmin: () => true, requireAutomationSecret: () => true,
        pool: { execute: async () => [[{ id: 42, whmcs_service_id: 9, plan_name: 'Old XXX' }]] },
        fetchWhmcsServiceById: async () => ({ raw: { productname: plan } }),
        extractWhmcsPlanName: (raw) => raw.productname,
        syncWhmcsPlanAccess: async (id, name) => {
          calls.push([id, name]);
          throw new Error('stop after access sync');
        },
        isSchemaMismatch: () => false, isWhmcsConfigError: () => false,
        sendInternalError() {},
      });
      await handler({ params: { code: 'ABC123' }, body: { device_code: 'ABC123' }, query: {} }, {});
      assert.deepEqual(calls, [[42, plan]], `${file}: ${plan}`);
    }
  }
});
