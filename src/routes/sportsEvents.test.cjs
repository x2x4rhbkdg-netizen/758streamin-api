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
  let fail = false, options;
  let sportsEnabled = true, device;
  const router = module.exports.createSportsEventsRouter({ auth, readSettings: async id => { device = id; return { sports_enabled: sportsEnabled }; }, load: async value => { options = value; if (fail) throw new Error('upstream secret detail'); return data; } });
  const route = router.stack.find(layer => layer.route?.path === '/sports/events').route;
  assert.equal(route.stack[0].handle, auth);
  const res = { code: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  const req = { device: { device_id: 42 } };
  await route.stack.at(-1).handle(req, res);
  assert.equal(device, 42);
  assert.equal(res.body, data); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  await route.stack.at(-1).handle({ ...req, query: { q: ' Texans ' } }, res);
  assert.equal(options.query, 'Texans');
  for (const q of [['NFL'], 'x'.repeat(101), 'bad\nquery', { name: 'NFL' }]) {
    await route.stack.at(-1).handle({ query: { q } }, res); assert.equal(res.code, 400);
  }
  sportsEnabled = false; await route.stack.at(-1).handle(req, res);
  assert.equal(res.code, 403); assert.equal(res.body.error, 'Sports is disabled for this device');
  sportsEnabled = undefined; await route.stack.at(-1).handle(req, res); assert.equal(res.code, 403);
  sportsEnabled = true; fail = true; await route.stack.at(-1).handle(req, res);
  assert.equal(res.code, 503); assert.equal(res.body.error, 'Sports events temporarily unavailable');
});

test('sports channel route uses authenticated device identity and sanitizes upstream failures', async () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./sportsEvents.routes.cjs'), 'utf8'), {
    module, require(name) {
      if (name === '../middleware/authJwt.cjs') return { authJwt: () => {} };
      return require(name);
    },
  });
  const auth = () => {}, calls = [];
  let error;
  const router = module.exports.createSportsEventsRouter({ auth, resolveChannels: async (...args) => {
    calls.push(args); if (error) throw error; return { event_id: args[1], channels: [] };
  } });
  const route = router.stack.find(layer => layer.route?.path === '/sports/events/:id/channels').route;
  assert.equal(route.stack[0].handle, auth);
  const req = { device: { device_id: 42 }, params: { id: 'fixture' }, query: { device_id: 999, broadcaster: 'untrusted' } };
  const res = { code: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle(req, res);
  assert.deepEqual(calls, [[42, 'fixture']]);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  error = Object.assign(new Error('Live TV disabled'), { status: 403 });
  await route.stack.at(-1).handle(req, res); assert.equal(res.code, 403);
  error = new Error('upstream secret credentials');
  await route.stack.at(-1).handle(req, res); assert.equal(res.code, 503);
  assert.equal(res.body.error, 'Live TV channels temporarily unavailable');
});
