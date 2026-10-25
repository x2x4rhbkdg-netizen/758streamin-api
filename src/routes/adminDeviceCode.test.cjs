const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceCodeRouter } = require('./adminDeviceCode.routes.cjs');
test('device-code route requires admin auth, rejects mixed updates and does not expose DB failures', async () => {
  const authenticate = () => {};
  const router = createDeviceCodeRouter({ authenticate, db: { getConnection: async () => { throw new Error('database secret'); } },
    onError: (_req, res) => res.status(500).json({ error: 'Internal error' }) });
  const route = router.stack.find(layer => layer.route).route;
  assert.equal(route.path, '/devices/:code/code'); assert.equal(route.stack[0].handle, authenticate);
  const call = async body => {
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await route.stack.at(-1).handle({ params: { code: 'OLD123' }, admin: { id: 1, role: 'super_admin' }, body }, res); return res;
  };
  assert.equal((await call({ device_code: 'NEW456', status: 'active' })).code, 400);
  assert.equal((await call({ device_code: 'bad' })).code, 400);
  const failure = await call({ device_code: 'NEW456' });
  assert.equal(failure.code, 500); assert.equal(failure.body.error, 'Internal error');
});
