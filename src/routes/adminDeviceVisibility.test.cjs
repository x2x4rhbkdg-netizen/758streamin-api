const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'admin.routes.cjs'), 'utf8');

function fixture(method, route, devices) {
  const start = source.indexOf(`router.${method}("${route}",`);
  const end = Math.min(...[source.indexOf('\n/**', start), source.indexOf('\nrouter.', start + 1), source.indexOf('\nmodule.exports', start)].filter(index => index >= 0));
  const queries = [];
  let handler;
  vm.runInNewContext(source.slice(start, end < 0 ? source.indexOf('\nmodule.exports', start) : end), {
    router: { [method](_path, _auth, callback) { handler = callback; } }, adminAuth() {},
    env: {}, pool: { async execute(sql, params) {
      queries.push({ sql, params: Array.from(params) });
      return [sql.trim().startsWith('SELECT') ? devices : { affectedRows: 1 }];
    } },
    toMysqlDatetime: value => value || null,
    normalizeBaseUrl: value => value,
    normalizePin: value => /^\d{4}$/.test(value || '') ? value : null,
    encryptString: value => `encrypted:${value}`,
    decryptString: value => value,
    sendInternalError(_req, res, _label, err) { throw err; },
  });
  return { queries, async run(role, id = 2, search = '') {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ admin: { role, id }, params: { code: 'ABC123' }, query: { search },
      body: { username: 'fixture', password: 'fixture', upstream_base_url: 'https://example.com', pin: '1234' } }, res);
    return res;
  } };
}

test('resellers see the full device list, including other owners and unassigned active devices', async () => {
  const rows = [{ id: 10, reseller_admin_id: 2 }, { id: 11, reseller_admin_id: 3 }, { id: 12, reseller_admin_id: null, status: 'active' }];
  const f = fixture('get', '/devices', rows);
  assert.equal((await f.run('reseller')).body.devices.length, 3);
  assert.doesNotMatch(f.queries[0].sql, /d\.reseller_admin_id=\?/);
  assert.deepEqual(f.queries[0].params, [8]);
});

test('resellers can operate another owners device; regular admins still cannot', async () => {
  for (const [method, route] of [
    ['post', '/devices/:code/activate'], ['post', '/devices/:code/suspend'],
    ['get', '/devices/:code/upstream'], ['post', '/devices/:code/upstream'],
    ['get', '/devices/:code/parental'], ['put', '/devices/:code/parental'], ['delete', '/devices/:code/parental'],
  ]) {
    const support = fixture(method, route, [{ id: 10, reseller_admin_id: 3 }]);
    assert.equal((await support.run('reseller')).code, 200, route);
    const blocked = fixture(method, route, [{ id: 10, reseller_admin_id: 3 }]);
    assert.equal((await blocked.run('admin')).code, 403, route);
    assert.equal(blocked.queries.length, 1);
  }
});

test('device content-settings accepts support resellers but denies non-owning regular admins', async () => {
  const start = source.indexOf("router.route('/devices/:code/movie-settings')");
  const end = source.indexOf('}).get(', start);
  let handler;
  vm.runInNewContext(`${source.slice(start, end)} });`, {
    router: { route() { return { all(_auth, callback) { handler = callback; } }; } }, adminAuth() {},
    pool: { execute: async () => [[{ id: 10, reseller_admin_id: 3 }]] },
    sendInternalError(_req, _res, _label, error) { throw error; },
  });
  for (const role of ['reseller', 'super_admin', 'admin']) {
    let called = false;
    const req = { admin: { id: 2, role }, params: { code: 'ABC123' } };
    const res = { status(code) { this.code = code; return this; }, json() { return this; } };
    await handler(req, res, () => { called = true; });
    assert.equal(called, role !== 'admin');
    if (called) assert.equal(req.movieDeviceId, 10);
  }
});

test('global reseller listing retains parameterized search; other admin roles retain existing scoping', async () => {
  for (const role of ['reseller', 'super_admin', 'admin']) {
    const f = fixture('get', '/devices', []);
    assert.equal((await f.run(role, 2, 'ABC')).code, 200);
    assert.match(f.queries[0].sql, /LOWER\(d.device_code\) LIKE LOWER\(\?\)/);
    assert.equal(f.queries[0].sql.includes('d.reseller_admin_id=?'), role === 'admin');
    assert.deepEqual(f.queries[0].params.slice(1, 5), ['%ABC%', '%ABC%', '%ABC%', '%ABC%']);
  }
});

test('reseller deletion is rejected before database access for owned, foreign and missing devices', async () => {
  for (const devices of [[{ id: 10, reseller_admin_id: 2 }], [{ id: 10, reseller_admin_id: 3 }], []]) {
    const f = fixture('delete', '/devices/:code', devices);
    assert.equal((await f.run('reseller')).code, 403);
    assert.equal(f.queries.length, 0);
  }
});

test('super-admin deletion and existing admin ownership checks are preserved', async () => {
  for (const [role, owner, expected] of [['super_admin', 3, 200], ['admin', 2, 200], ['admin', 3, 403]]) {
    const f = fixture('delete', '/devices/:code', [{ id: 10, reseller_admin_id: owner }]);
    assert.equal((await f.run(role)).code, expected);
    assert.equal(f.queries.some(query => query.sql.startsWith('DELETE FROM devices')), expected === 200);
  }
});
