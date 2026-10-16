const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bcrypt = require('bcryptjs');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.patch("/admins/:id",');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start, 'Account PATCH handler must exist');
  let handler;
  const calls = [];
  const auth = () => {};
  const admin = { id: 2, name: 'Account', email: 'account@example.com', role: 'reseller', status: 'active' };
  vm.runInNewContext(source.slice(start, end), {
    Buffer, bcrypt,
    adminAuth: auth,
    router: { patch(route, middleware, callback) {
      assert.equal(route, '/admins/:id'); assert.equal(middleware, auth); handler = callback;
    } },
    requireSuperAdmin(req, res) {
      if (req.admin.role === 'super_admin') return true;
      res.status(403).json({ error: 'forbidden' }); return false;
    },
    pool: { async execute(sql, params) {
      calls.push({ sql, params });
      return sql.trim().startsWith('SELECT') ? [[admin]] : [{ affectedRows: 1 }];
    } },
    sendInternalError(_req, res) { return res.status(500).json({ error: 'internal error' }); },
  });
  return { calls, async patch(body, actor = { id: 1, role: 'super_admin' }) {
    const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await handler({ params: { id: '2' }, body, admin: actor }, response);
    return response;
  } };
}

test('account password update stores a bcrypt hash, not plaintext, and returns only profile data', async () => {
  const { patch, calls } = fixture();
  const password = 'a-new-test-password';
  const result = await patch({ password, name: 'Updated' });
  assert.equal(result.statusCode, 200);
  const update = calls[0];
  assert.match(update.sql, /password_hash=\?/);
  const hash = update.params.find((value) => typeof value === 'string' && value.startsWith('$2'));
  assert.equal(await bcrypt.compare(password, hash), true);
  assert.equal(bcrypt.getRounds(hash), 12);
  assert.equal(update.params.includes(password), false);
  assert.equal(JSON.stringify(result.body).includes(password), false);
  assert.equal(result.body.admin.password_hash, undefined);
});

test('blank and omitted edit passwords leave the existing hash untouched', async () => {
  for (const body of [{ name: 'Updated' }, { name: 'Updated', password: '' }]) {
    const { patch, calls } = fixture();
    assert.equal((await patch(body)).statusCode, 200);
    assert.doesNotMatch(calls[0].sql, /password_hash/);
  }
});

test('invalid passwords fail before any database writes', async () => {
  for (const password of ['short', 12345678, null, {}, [], 'x'.repeat(73), '\u00e9'.repeat(37)]) {
    const { patch, calls } = fixture();
    assert.equal((await patch({ password, name: 'Updated' })).statusCode, 400);
    assert.equal(calls.length, 0);
  }
});

test('non-super-admin callers cannot change an account password', async () => {
  const { patch, calls } = fixture();
  assert.equal((await patch({ password: 'test-password' }, { id: 3, role: 'reseller' })).statusCode, 403);
  assert.equal(calls.length, 0);
});

test('status-only changes still work without updating a password', async () => {
  const { patch, calls } = fixture();
  assert.equal((await patch({ status: 'disabled' })).statusCode, 200);
  assert.match(calls[0].sql, /status=\?/);
  assert.doesNotMatch(calls[0].sql, /password_hash/);
});
