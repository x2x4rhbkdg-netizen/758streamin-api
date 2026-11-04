const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ online = 1 } = {}) {
  const source = fs.readFileSync(require.resolve('./admin.routes.cjs'), 'utf8');
  const start = source.indexOf('router.get("/devices",');
  const end = source.indexOf('\n/**', start);
  const calls = [];
  let handler, nameLookups = 0;
  vm.runInNewContext(source.slice(start, end), {
    router: { get(_path, auth, callback) { assert.equal(auth, adminAuth); handler = callback; } },
    adminAuth, env: {},
    pool: { execute: async (sql, params) => {
      calls.push({ sql, params: Array.from(params) });
      if (sql.includes('FROM devices d')) return [[{ id: 1, device_code: 'ABC123', online }]];
      return [[{ device_id: 1, content_id: '42', content_type: 'stream', event_type: 'play' }]];
    } },
    resolveAnalyticsContentNames: async () => { nameLookups++; return new Map([['stream:42', 'Fixture channel']]); },
    normalizeAnalyticsLookupType: value => value,
    getAnalyticsRowContentName: () => null,
    sendInternalError(_req, _res, _label, err) { throw err; },
  });
  function adminAuth() {}
  return { calls, get nameLookups() { return nameLookups; }, async run(query = {}, role = 'reseller') {
    const res = { json(body) { this.body = body; return this; } };
    await handler({ query, admin: { id: 7, role } }, res);
    return res.body;
  } };
}

test('presence polls execute one small devices read without joins, sort, analytics or name resolution', async () => {
  const f = fixture();
  await f.run({ presence: '1' });
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0].sql, /JOIN|ORDER BY|customer_name|meta_json|device_access/);
  assert.deepEqual(f.calls[0].params, [8]);
  assert.equal(f.nameLookups, 0);
});

test('presence uses the same regular-admin scope; reseller and super-admin remain global', async () => {
  for (const role of ['admin', 'reseller', 'super_admin']) {
    const f = fixture();
    await f.run({ presence: '1' }, role);
    assert.equal(f.calls[0].sql.includes('d.reseller_admin_id=?'), role === 'admin');
    assert.deepEqual(f.calls[0].params, role === 'admin' ? [8, 7] : [8]);
  }
});

test('optional playback poll and full list use a timestamp range and preserve content labels', async () => {
  for (const query of [{ presence: '1', playback: '1' }, {}]) {
    const f = fixture();
    const result = await f.run(query);
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].sql, /ae.created_at >= DATE_SUB\(NOW\(\), INTERVAL \? SECOND\)/);
    assert.doesNotMatch(f.calls[1].sql, /TIMESTAMPDIFF/);
    assert.deepEqual(f.calls[1].params, [1, 120]);
    assert.equal(result.devices[0].current_content_name, 'Fixture channel');
  }
});

test('offline devices do not trigger analytics even when playback is requested', async () => {
  const f = fixture({ online: 0 });
  await f.run({ presence: '1', playback: '1' });
  assert.equal(f.calls.length, 1);
});
