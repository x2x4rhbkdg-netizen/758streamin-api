const test = require('node:test');
const assert = require('node:assert/strict');
const { createThePornDbAdminRouter } = require('./adminThePornDb.routes.cjs');
test('ThePornDB connection test is super-admin-only, uses masked stored credentials and throttles requests', async () => {
  const received = [];
  let time = 10000;
  const router = createThePornDbAdminRouter({ authenticate: (_req, _res, next) => next(),
    authorize: (req, res) => req.admin.role === 'super_admin' || (res.status(403).json({ error: 'Forbidden' }), false),
    readSettings: async () => ({ theporndb_token: 'stored-private-token' }), now: () => time,
    client: { test: async token => { received.push(token); return { status: 'connected' }; } } });
  async function invoke(role, body) {
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await router.stack[0].route.stack.at(-1).handle({ admin: { id: 1, role }, body }, res);
    return res;
  }
  assert.equal((await invoke('reseller', {})).code, 403); assert.equal(received.length, 0);
  const result = await invoke('super_admin', {});
  assert.equal(result.body.status, 'connected');
  assert.equal(JSON.stringify(result.body).includes('stored-private-token'), false);
  assert.deepEqual(received, ['stored-private-token']);
  assert.equal((await invoke('super_admin', {})).code, 429);
  time += 6000;
  await invoke('super_admin', { token: 'unsaved-private-token' });
  assert.equal(received.at(-1), 'unsaved-private-token');
});
