const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(rows = []) {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.get("/admins",');
  const end = source.indexOf('router.post("/admins",', start);
  let handler;
  const calls = [];
  vm.runInNewContext(source.slice(start, end), {
    adminAuth() {},
    router: { get(_route, _auth, callback) { handler = callback; } },
    requireSuperAdmin(req, res) {
      if (req.admin.role === 'super_admin') return true;
      res.status(403).json({ error: 'forbidden' }); return false;
    },
    pool: { async execute(sql, params) { calls.push({ sql, params }); return [rows]; } },
    sendInternalError(_req, res) { return res.status(500).json({ error: 'internal error' }); },
  });
  return { calls, async list(query = {}, role = 'super_admin') {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ query, admin: { role } }, res);
    return res;
  } };
}

test('account list returns numeric device counts and preserves zero-device accounts', async () => {
  const { list, calls } = fixture([{ id: 1, device_count: '12' }, { id: 2, device_count: 0 }]);
  const response = await list();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.admins[0].device_count, 12);
  assert.equal(response.body.admins[1].device_count, 0);
  assert.equal(calls.length, 1, 'counts must not require one query per reseller');
  assert.match(calls[0].sql, /COALESCE\(dc.device_count, 0\)/);
  assert.match(calls[0].sql, /GROUP BY d.reseller_admin_id/);
  assert.match(calls[0].sql, /dc.reseller_admin_id = a.id/);
  assert.match(calls[0].sql, /t.retained_device_id IS NULL/);
  assert.doesNotMatch(calls[0].sql, /d.status\s*=/, 'all assigned device statuses count');
});

test('role filter stays parameterized after adding the count join', async () => {
  const { list, calls } = fixture();
  await list({ role: 'reseller' });
  assert.match(calls[0].sql, /WHERE a.role=\?/);
  assert.equal(calls[0].params[0], 'reseller');
});

test('device totals remain restricted to super admins', async () => {
  for (const role of ['reseller', 'admin']) {
    const { list, calls } = fixture();
    assert.equal((await list({}, role)).statusCode, 403);
    assert.equal(calls.length, 0);
  }
});
