const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(initial = []) {
  let records = initial.map(row => ({ channel: 'direct', platform: 'android_tv', status: 'active', ...row }));
  const queries = [];
  const devices = [{ id: 10, device_code: 'ONE123', device_uuid: 'uuid-one' }, { id: 20, device_code: 'TWO456', device_uuid: 'uuid-two' }];
  const pool = { async execute(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('SELECT id FROM devices')) {
      return [devices.filter(device => sql.includes('device_uuid')
        ? device.device_uuid === params[0] && (!sql.includes('AND device_code') || device.device_code === params[1])
        : device.device_code === params[0])];
    }
    if (sql.includes('INSERT INTO app_updates')) {
      const columns = ['channel', 'platform', 'version_code', 'version_name', 'apk_url', 'sha256', 'force_update', 'status', 'notes', 'created_by_admin_id', 'target_device_id'];
      const row = Object.fromEntries(columns.map((key, index) => [key, params[index]]));
      row.id = records.length + 1; records.push(row); return [{ insertId: row.id }];
    }
    if (sql.includes('UPDATE app_updates')) {
      const row = records.find(row => row.id === params.at(-1));
      if (!row) return [{ affectedRows: 0 }];
      let index = 0;
      for (const match of sql.split('WHERE')[0].matchAll(/(\w+)=\?/g)) row[match[1]] = params[index++];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SELECT * FROM app_updates')) return [records.filter(row => row.id === params[0])];
    if (sql.includes('FROM app_updates au')) return [records.filter(row => !sql.includes('au.target_device_id=0') || !row.target_device_id)
      .map(row => ({ ...row, target_device_code: devices.find(device => device.id === row.target_device_id)?.device_code || null }))];
    if (sql.includes('FROM app_updates')) {
      assert.match(sql, /target_device_id=0 OR target_device_id=\?/);
      assert.match(sql, /ORDER BY version_code DESC, \(target_device_id<>0\) DESC/);
      const selected = records.filter(row => row.status === 'active' && row.channel === params[0]
        && (params.length < 3 || row.platform === params[1] || row.platform === 'all')
        && (!row.target_device_id || row.target_device_id === params.at(-1)))
        .sort((a, b) => b.version_code - a.version_code || Number(!!b.target_device_id) - Number(!!a.target_device_id));
      return [selected.slice(0, 1)];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  function load(path) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve(path), 'utf8'), { module, URL, console,
      require(name) {
        if (name.includes('db/pool')) return { pool };
        if (name.includes('adminAuth')) return { adminAuth: (_req, _res, next) => next() };
        if (name.includes('errorResponse')) return { sendInternalError: (_req, res, _area, error) => res.status(500).json({ error: error.message }) };
        return require(name);
      },
    });
    return module.exports;
  }
  const admin = load('./admin.appUpdates.routes.cjs'), app = load('./appUpdate.routes.cjs');
  async function invoke(router, method, path, body = {}, role = 'super_admin') {
    const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
    const req = { body, query: {}, params: { id: 1 }, admin: { id: 1, role } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    for (const layer of route.stack) { let next = false; await layer.handle(req, res, () => { next = true; }); if (!next) break; }
    return res;
  }
  return { queries, records, create: (body, role) => invoke(admin, 'post', '/app-updates', body, role),
    patch: body => invoke(admin, 'patch', '/app-updates/:id', body),
    list: role => invoke(admin, 'get', '/app-updates', {}, role),
    check: body => invoke(app, 'post', '/app/update/check', { channel: 'direct', platform: 'android_tv', version_code: 5, ...body }) };
}
const release = { channel: 'direct', platform: 'android_tv', version_code: 10, version_name: '1.0', apk_url: 'https://example.com/update.apk' };

test('admin creates global or targeted releases, validates targets and preserves them on unrelated edits', async () => {
  const f = fixture();
  assert.equal((await f.create({ ...release, target_device_code: ' one123 ' })).code, 201);
  assert.equal(f.records[0].target_device_id, 10);
  await f.patch({ notes: 'Changed notes' }); assert.equal(f.records[0].target_device_id, 10);
  await f.patch({ target_device_code: 'TWO456' }); assert.equal(f.records[0].target_device_id, 20);
  await f.patch({ target_device_code: null }); assert.equal(f.records[0].target_device_id, 0);
  const before = f.records.length;
  assert.equal((await f.create({ ...release, target_device_code: 'MISSING' })).code, 404);
  assert.equal((await f.create({ ...release, target_device_code: {} })).code, 400);
  assert.equal((await f.create(release, 'reseller')).code, 403);
  assert.equal(f.records.length, before);
});

test('targeted higher version is never offered to other devices, missing identities or mismatched UUID/code pairs', async () => {
  const f = fixture([{ id: 1, version_code: 10, target_device_id: 0 }, { id: 2, version_code: 20, target_device_id: 10 }]);
  assert.equal((await f.check({ device_uuid: 'uuid-one', device_code: 'ONE123' })).body.latest_version_code, 20);
  for (const identity of [{ device_uuid: 'uuid-two' }, {}, { device_code: 'ONE123' }, { device_uuid: 'uuid-one', device_code: 'TWO456' }]) {
    assert.equal((await f.check(identity)).body.latest_version_code, 10);
  }
  const response = await f.check({ device_uuid: 'uuid-one', version_code: 20 });
  assert.equal(response.body.available, false);
  assert.equal(response.body.target_device_id, undefined);
});

test('same-version targeted release wins only for its device; inactive and incompatible releases cannot hide valid global updates', async () => {
  const f = fixture([
    { id: 1, version_code: 10, target_device_id: 0, apk_url: 'global.apk' },
    { id: 2, version_code: 10, target_device_id: 10, apk_url: 'target.apk' },
    { id: 3, version_code: 30, target_device_id: 10, status: 'inactive' },
    { id: 4, version_code: 40, target_device_id: 10, platform: 'android_mobile' },
  ]);
  assert.equal((await f.check({ device_uuid: 'uuid-one' })).body.apk_url, 'target.apk');
  assert.equal((await f.check({ device_uuid: 'uuid-two' })).body.apk_url, 'global.apk');
});

test('target-only release reports unavailable to non-recipients and remains visible only to super admins', async () => {
  const f = fixture([{ id: 1, version_code: 10, target_device_id: 10 }]);
  assert.equal((await f.check({ device_uuid: 'uuid-two' })).body.available, false);
  assert.equal((await f.list('reseller')).body.updates.length, 0);
  assert.equal((await f.list('super_admin')).body.updates[0].target_device_code, 'ONE123');
});
