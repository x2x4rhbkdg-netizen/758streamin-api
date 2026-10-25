const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('sports route requires existing device auth and returns only neutral failure text', async () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./sportsEvents.routes.cjs'), 'utf8'), {
    module, require(name) {
      if (name === '../middleware/authJwt.cjs') return { authJwt: (_req, _res, next) => next() };
      return require(name);
    },
  });
  const auth = () => {}, data = { events: [{ id: '1' }] };
  let fail = false;
  const router = module.exports.createSportsEventsRouter({ auth, load: async () => { if (fail) throw new Error('upstream secret detail'); return data; } });
  const route = router.stack.find(layer => layer.route?.path === '/sports/events').route;
  assert.equal(route.stack[0].handle, auth);
  const res = { code: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({}, res);
  assert.equal(res.body, data); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  fail = true; await route.stack.at(-1).handle({}, res);
  assert.equal(res.code, 503); assert.equal(res.body.error, 'Sports events temporarily unavailable');
});
