const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createAdminPasswordRouter } = require('./adminPassword.routes.cjs');

async function fixture() {
  const oldHash = await bcrypt.hash('old-test-password', 4);
  const calls = [];
  let updated = false;
  const db = { async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT')) return [[{ password_hash: oldHash, status: 'active' }]];
    return [{ affectedRows: updated ? 0 : (updated = true, 1) }];
  } };
  const router = createAdminPasswordRouter({ db, authenticate: (_req, _res, next) => next(),
    onError: (_req, res) => res.status(500).json({ error: 'Unavailable' }) });
  const handler = router.stack[0].route.stack.at(-1).handle;
  return { calls, async change(body, id = 17) {
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ admin: { id }, body }, res);
    return res;
  } };
}
const input = { current_password: 'old-test-password', new_password: 'new-test-password' };

test('self-service update uses authenticated ID only and stores bcrypt, never plaintext', async () => {
  const { change, calls } = await fixture();
  const res = await change({ ...input, admin_id: 99, id: 99, role: 'super_admin' });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls[0].params, [17]);
  assert.equal(calls[1].params[1], 17);
  assert.equal(await bcrypt.compare(input.new_password, calls[1].params[0]), true);
  assert.equal(bcrypt.getRounds(calls[1].params[0]), 12);
  assert.equal(calls[1].params.includes(input.new_password), false);
});
test('wrong current password performs no write', async () => {
  const { change, calls } = await fixture();
  assert.equal((await change({ ...input, current_password: 'wrong' })).code, 400);
  assert.equal(calls.length, 1);
});
test('requires an actual signed-in account, not API-key-only identity', async () => {
  const { change, calls } = await fixture();
  assert.equal((await change(input, null)).code, 401);
  assert.equal(calls.length, 0);
});
test('invalid, oversized, and unchanged passwords fail before database access', async () => {
  const { change, calls } = await fixture();
  for (const password of ['', 'short', 12345, null, 'x'.repeat(73), '\u00e9'.repeat(37), input.current_password]) {
    assert.equal((await change({ ...input, new_password: password })).code, 400);
  }
  assert.equal(calls.length, 0);
});
test('repeated incorrect passwords are rate limited', async () => {
  const { change } = await fixture();
  for (let i = 0; i < 5; i++) assert.equal((await change({ ...input, current_password: 'wrong' })).code, 400);
  assert.equal((await change(input)).code, 429);
});
test('concurrent password changes cannot overwrite an already changed password', async () => {
  const { change } = await fixture();
  assert.equal((await change(input)).code, 200);
  assert.equal((await change(input)).code, 409);
});
