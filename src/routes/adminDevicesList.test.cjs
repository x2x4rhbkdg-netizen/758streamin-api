const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.get("/devices",');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);

  const rows = Array.from({ length: 201 }, (_, index) => ({
    id: index + 1,
    device_code: `DEVICE${index + 1}`,
    online: false,
  }));
  const calls = [];
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    adminAuth() {},
    router: { get(_path, _auth, callback) { handler = callback; } },
    env: {},
    pool: { async execute(sql, params) {
      calls.push({ sql, params });
      return [rows];
    } },
    sendInternalError: (_req, res) => res.status(500).json({ error: 'Internal error' }),
  });

  return {
    calls,
    async list(admin) {
      const res = { json(body) { this.body = body; return this; } };
      await handler({ query: {}, admin }, res);
      return res.body;
    },
  };
}

test('super admin receives devices beyond the former 200-device cap', async () => {
  const { calls, list } = fixture();
  const result = await list({ id: 1, role: 'super_admin' });
  assert.equal(result.devices.length, 201);
  assert.doesNotMatch(calls[0].sql, /\bLIMIT\s+200\b/i);
  assert.doesNotMatch(calls[0].sql, /d\.reseller_admin_id\s*=\s*\?/);
});

test('reseller device listing remains scoped to its own devices', async () => {
  const { calls, list } = fixture();
  await list({ id: 7, role: 'reseller' });
  assert.match(calls[0].sql, /d\.reseller_admin_id\s*=\s*\?/);
  assert.deepEqual(Array.from(calls[0].params), [8, 7]);
});
