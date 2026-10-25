const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeLiveFavorite, createLiveFavoritesStore } = require('../utils/liveFavorites.cjs');
function fixture() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./liveFavorites.routes.cjs'), 'utf8'), { module, Date, Set, Map, require(name) {
    if (name.includes('authJwt')) return { authJwt() {} };
    if (name.includes('movieSettings')) return { readMovieSettings: async () => ({}) };
    return require(name);
  } });
  const entries = new Map(), owners = { 1: 'account-a', 2: 'account-a', 3: 'account-b' }, settings = { live_tv_enabled: true, radio_enabled: false };
  const auth = () => {}, store = { owner: async device => owners[device], list: async owner => [...entries.values()].filter(value => value.owner === owner).map(value => value.entry),
    put: async (owner, entry) => { const key = `${owner}:${entry.stream_id}`; if (!entries.has(key) || entries.get(key).entry.updatedAt <= entry.updatedAt) entries.set(key, { owner, entry }); } };
  const router = module.exports.createLiveFavoritesRouter({ auth, store, readSettings: async () => settings });
  const invoke = async (method, body, device = 1) => {
    const req = { body, device: { device_id: device } }, res = { code: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    const middleware = router.stack.find(layer => !layer.route).handle;
    const guard = middleware; // Express creates one layer for each .use handler.
    assert.equal(guard, auth);
    let allowed = false;
    await router.stack.filter(layer => !layer.route)[1].handle(req, res, () => { allowed = true; });
    if (allowed) await router.stack.find(layer => layer.route?.methods[method.toLowerCase()]).route.stack.at(-1).handle(req, res);
    return res;
  };
  return { invoke, owners, entries, settings };
}
const favorite = { stream_id: '12', favorite: true, updatedAt: 100 };
test('favourites restore to another linked device and reject another accounts writes', async () => {
  const f = fixture(); assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries: [favorite] })).code, 200);
  assert.equal((await f.invoke('GET', {}, 2)).body.entries[0].stream_id, '12');
  assert.equal((await f.invoke('GET', {}, 3)).body.entries.length, 0);
  assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries: [favorite] }, 3)).code, 409);
});
test('newer removals defeat old offline additions; replies contain actual saved state', async () => {
  const f = fixture(); await f.invoke('PUT', { account_key: 'account-a', entries: [{ ...favorite, favorite: false, updatedAt: 200 }] });
  const old = await f.invoke('PUT', { account_key: 'account-a', entries: [favorite] });
  assert.equal(old.body.entries[0].favorite, false);
});
test('validation, disabled services and malformed batches cannot write preferences', async () => {
  const f = fixture();
  for (const entries of [[], Array(101).fill(favorite), [favorite, favorite], [{ ...favorite, stream_id: 'https://secret' }], [{ ...favorite, favorite: 'yes' }]]) {
    assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries })).code, 400);
  }
  f.settings.live_tv_enabled = false;
  assert.equal((await f.invoke('GET')).code, 403); assert.equal(f.entries.size, 0);
});
test('only IDs and favourite state are retained; timestamps are bounded', () => {
  assert.deepEqual(normalizeLiveFavorite({ ...favorite, updatedAt: 9999, playbackUrl: 'secret' }, 1000), { ...favorite, updatedAt: 1000 });
});
test('storage scopes favourites to account and upstream login while retaining scope across password changes', async () => {
  const writes = []; let username = 'customer', password = 'one';
  const store = createLiveFavoritesStore({ db: { async execute(sql, params) {
    if (sql.startsWith('SELECT id')) return [[{ id: params[0], whmcs_client_id: params[0] === 3 ? 99 : 44 }]];
    writes.push({ sql, params }); return [[]];
  } }, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
    getUpstream: async () => ({ upstream_base_url: 'https://provider.example/', username, password }) });
  const owner = await store.owner(1); assert.equal(owner, await store.owner(2)); assert.notEqual(owner, await store.owner(3));
  password = 'two'; assert.equal(owner, await store.owner(1)); username = 'other'; assert.notEqual(owner, await store.owner(1));
  await store.put(owner, favorite); const write = writes.at(-1);
  assert.equal(write.params[1], 'live'); assert.match(write.sql, /GREATEST/); assert.equal(JSON.stringify(write.params).includes('customer'), false);
});
