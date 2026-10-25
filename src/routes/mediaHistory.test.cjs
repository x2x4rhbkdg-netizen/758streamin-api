const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createMediaHistoryStore, normalizeHistory } = require('../utils/mediaHistory.cjs');

function fixture() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./mediaHistory.routes.cjs'), 'utf8'), {
    module, Date, require(name) {
      if (name === '../middleware/authJwt.cjs') return { authJwt: (_req, _res, next) => next() };
      if (name === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({}) };
      return require(name);
    },
  });
  const records = new Map();
  const owners = { 1: 'account-a', 2: 'account-a', 3: 'account-b' };
  const store = {
    owner: async device => owners[device],
    list: async owner => [...records.values()].filter(record => record.owner === owner).map(record => record.entry),
    put: async (owner, section, key, entry) => {
      const id = `${owner}:${section}:${key}`;
      if (!records.has(id) || records.get(id).entry.updatedAt <= entry.updatedAt) records.set(id, { owner, entry });
    },
  };
  const settings = { enabled: true, anime_enabled: true };
  const router = module.exports.createMediaHistoryRouter({ store, readSettings: async () => settings });
  async function invoke(method, body, device = 1) {
    const route = router.stack.find(layer => layer.route?.methods[method.toLowerCase()]).route;
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await route.stack.at(-1).handle({ body, device: { device_id: device } }, res);
    return res;
  }
  return { invoke, owners, records, settings };
}
const entry = { id: '10', type: 'series', title: 'Fixture', season: 1, episode: 2, position: 60, duration: 1800, updatedAt: 100 };
test('anime history round trips only supported language preferences', () => {
  for (const sourceLanguage of ['dub', 'all']) assert.equal(normalizeHistory({ ...entry, section: 'anime', sourceLanguage }).entry.sourceLanguage, sourceLanguage);
  assert.equal(normalizeHistory({ ...entry, sourceLanguage: 'dub' }).entry.sourceLanguage, undefined);
  assert.equal(normalizeHistory({ ...entry, section: 'anime', sourceLanguage: 'invalid' }).entry.sourceLanguage, undefined);
});

test('same WHMCS account restores progress on another device and excludes other accounts', async () => {
  const f = fixture();
  assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries: [entry] })).code, 200);
  assert.equal((await f.invoke('GET', {}, 2)).body.entries[0].position, 60);
  assert.equal((await f.invoke('GET', {}, 3)).body.entries.length, 0);
  assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries: [entry], whmcs_client_id: 1 }, 3)).code, 409);
});
test('older offline progress cannot resurrect a completed episode', async () => {
  const f = fixture();
  await f.invoke('PUT', { account_key: 'account-a', entries: [{ ...entry, position: 1790, updatedAt: 200 }] });
  await f.invoke('PUT', { account_key: 'account-a', entries: [entry] }, 2);
  assert.equal((await f.invoke('GET', {})).body.entries[0].position, 1790);
});
test('reassigning a device refuses pending writes from its old account', async () => {
  const f = fixture(); f.owners[1] = 'account-b';
  assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries: [entry] })).code, 409);
  assert.equal(f.records.size, 0);
});
test('ordinary history rejects Adult records, malformed progress and oversized batches', async () => {
  const f = fixture();
  for (const entries of [[{ ...entry, section: 'adult' }], [{ ...entry, position: -1 }], Array(21).fill(entry), []]) {
    assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries })).code, 400);
  }
  assert.equal(f.records.size, 0);
});
test('device media switches are enforced on history reads and writes', async () => {
  const f = fixture(); f.settings.enabled = false; f.settings.anime_enabled = false;
  assert.equal((await f.invoke('GET', {})).code, 403);
  assert.equal((await f.invoke('PUT', { account_key: 'account-a', entries: [entry] })).code, 403);
  assert.equal(f.records.size, 0);
});
test('storage resolves owner only from the device record and encrypts the saved payload', async () => {
  const calls = [];
  const store = createMediaHistoryStore({ db: { async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id')) return [[{ id: params[0], whmcs_client_id: params[0] === 3 ? null : 44 }]];
    return [{}];
  } }, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  const owner = await store.owner(1);
  assert.equal(owner, await store.owner(2));
  assert.notEqual(owner, await store.owner(3));
  const record = normalizeHistory({ ...entry, playbackUrl: 'https://example.com/secret' });
  await store.put(owner, record.section, record.key, record.entry);
  const write = calls.at(-1);
  assert.match(write.sql, /GREATEST/);
  assert.equal(write.params.includes('Fixture'), false);
  assert.equal(JSON.stringify(record.entry).includes('playbackUrl'), false);
});
