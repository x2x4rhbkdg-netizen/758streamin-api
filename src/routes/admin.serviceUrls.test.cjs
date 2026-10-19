const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceUrlsRouter, serviceOrigin } = require('./admin.serviceUrls.routes.cjs');

function fixture(execute = async () => [[]]) {
  const calls = [];
  const router = createServiceUrlsRouter({ db: { execute: async (...args) => { calls.push(args); return execute(...args); } },
    authenticate: (_req, _res, next) => next(), defaultUrl: 'https://default.example:443/',
    onError: (_req, res) => res.status(500).json({ error: 'Unavailable' }) });
  return { calls, router, async run(method, body = {}, query = {}, id) {
    const path = id === undefined ? '/service-urls' : '/service-urls/:id';
    const layer = router.stack.find(value => value.route?.path === path && value.route.methods[method]);
    const req = { body, query, params: { id } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await layer.route.stack.at(-1).handle(req, res); return res;
  } };
}
test('service URLs accept only HTTP(S) origins and normalize trailing slashes and ports', () => {
  assert.equal(serviceOrigin('https://STREAM.example:443/'), 'https://stream.example');
  assert.equal(serviceOrigin('http://stream.example:8080'), 'http://stream.example:8080');
  for (const value of ['ftp://stream.example', 'https://user:pass@stream.example', 'https://stream.example/api', 'https://stream.example?token=secret', 'https://stream.example/#x', null, 42]) assert.equal(serviceOrigin(value), null);
});
test('autocomplete uses parameterized literal search and resolves saved/default friendly names', async () => {
  const service = { id: 2, name: 'Main Service', url: 'https://default.example' };
  const { run, calls } = fixture(async () => [[service]]);
  const res = await run('get', {}, { q: '50%_!', current_url: 'https://default.example/' });
  assert.equal(res.body.selected_service.name, 'Main Service'); assert.equal(res.body.default_service.id, 2);
  assert.deepEqual(calls[0][1], ['%50!%!_!!%', '%50!%!_!!%']);
  assert.match(calls[0][0], /LIMIT 50/);
});
test('the existing XUI URL is the fallback without rewriting device records', async () => {
  const { run, calls } = fixture();
  const res = await run('get');
  assert.deepEqual(res.body.default_service, { id: 'default', name: 'Default Service', url: 'https://default.example' });
  assert.equal(calls.every(([sql]) => sql.startsWith('SELECT')), true);
});
test('only super admins can mutate; authenticated resellers can search, and middleware is directory-scoped', () => {
  const { router } = fixture();
  const layer = router.stack[0];
  assert.equal(layer.regexp.test('/app-updates'), false);
  const guard = router.stack[1].handle;
  for (const [method, role, allowed] of [['GET', 'reseller', true], ['POST', 'reseller', false], ['PATCH', 'super_admin', true], ['DELETE', 'super-admin', true]]) {
    let next = false;
    const res = { status(code) { this.code = code; return this; }, json() { return this; } };
    guard({ method, admin: { role } }, res, () => { next = true; });
    assert.equal(next, allowed); if (!allowed) assert.equal(res.code, 403);
  }
});
test('create and edit store normalized origins and names without changing device_upstream', async () => {
  const { run, calls } = fixture(async sql => sql.startsWith('SELECT') ? [[{ id: 3 }]] : [{ insertId: 3, affectedRows: 1 }]);
  const created = await run('post', { name: ' Main ', url: 'https://stream.example:443/' });
  assert.equal(created.code, 201); assert.deepEqual(calls[0][1], ['Main', 'https://stream.example']);
  assert.equal((await run('patch', { name: 'Renamed', url: 'http://stream.example:8080' }, {}, '3')).code, 200);
  assert.equal(calls.some(([sql]) => /device_upstream/.test(sql)), false);
});
test('validation, missing rows, duplicate origins and missing migration have explicit errors', async () => {
  const invalid = fixture();
  assert.equal((await invalid.run('post', { name: '', url: 'https://ok.example' })).code, 400);
  assert.equal(invalid.calls.length, 0);
  assert.equal((await invalid.run('patch', { name: 'Missing', url: 'https://ok.example' }, {}, '7')).code, 404);
  for (const [code, expected] of [['ER_DUP_ENTRY', 409], ['ER_NO_SUCH_TABLE', 503]]) {
    const { run } = fixture(async () => { throw Object.assign(new Error(), { code }); });
    assert.equal((await run('post', { name: 'Main', url: 'https://ok.example' })).code, expected);
  }
});
test('deleting a directory entry leaves saved device URLs untouched', async () => {
  const { run, calls } = fixture(async () => [{ affectedRows: 1 }]);
  assert.equal((await run('delete', {}, {}, '5')).code, 200);
  assert.deepEqual(calls, [['DELETE FROM service_urls WHERE id=?', [5]]]);
  assert.equal((await run('delete', {}, {}, '../1')).code, 400);
});
