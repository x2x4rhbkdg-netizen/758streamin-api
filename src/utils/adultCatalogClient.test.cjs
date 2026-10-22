const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdultCatalogClient, validateAdultSelection } = require('./adultCatalogClient.cjs');
const { createAdultAddonClient, addonVersion } = require('./adultAddons.cjs');
const { provider } = require('./thePornDb.cjs');
const addon = { id: 'source', name: 'Fixture', scopes: ['adult'], enabled: true, manifest_url: 'https://fixture.example/manifest.json' };
const settings = { theporndb_enabled: true, theporndb_token: 'secret', stremio_addons: [addon] };
const item = { id: 'tpdb:scenes:fixture-1', tpdb_kind: 'scenes', tpdb_id: 'fixture-1', addon_id: '__tpdb', addon_version: addonVersion(provider(settings)) };

test('composite catalogs keep existing add-ons and scoped ThePornDB identity', async () => {
  const client = createAdultCatalogClient({ addons: { catalogs: async () => ({ catalogs: [{ id: 'legacy' }] }) },
    tpdb: { catalogs: () => [{ id: 'scenes' }], catalog: async () => ({ items: [item], has_more: true }), details: async (_settings, value) => ({ ...value, videos: [] }) } });
  assert.deepEqual((await client.catalogs(settings)).catalogs.map(c => c.id), ['scenes', 'legacy']);
  assert.equal((await client.catalog(settings, { addon_id: '__tpdb' })).items[0].addon_version, item.addon_version);
  assert.equal((await client.details(settings, item)).id, item.id);
  assert.throws(() => validateAdultSelection({ ...settings, theporndb_enabled: false }, item), { status: 409 });
  assert.throws(() => validateAdultSelection({ ...settings, theporndb_token: 'changed' }, item), { status: 409 });
});

test('ThePornDB sources need an explicitly compatible manifest, never title search or a generic prefix', async () => {
  const calls = [];
  let prefix;
  const addons = createAdultAddonClient({ fetchText: async url => {
    calls.push(url);
    return JSON.stringify(url.endsWith('/manifest.json') ? { id: 'fixture', types: ['movie'], resources: ['stream'], ...(prefix ? { idPrefixes: [prefix] } : {}) }
      : { streams: [{ infoHash: 'a'.repeat(40), title: 'Fixture' }, { url: 'http://insecure.example/video' }, { externalUrl: 'https://publisher.example' }] });
  } });
  for (const value of [undefined, 't', 'tpdb:wrong:']) {
    prefix = value; assert.deepEqual(await addons.metadataSources(settings, item), []);
  }
  assert.equal(calls.some(url => url.includes('/stream/')), false);
  prefix = 'tpdb:';
  const sources = await addons.metadataSources(settings, item);
  assert.equal(sources.length, 1); assert.equal(sources[0].source_addon_id, 'source');
  assert.ok(calls.at(-1).endsWith('/stream/movie/tpdb%3Ascenes%3Afixture-1.json'));
  validateAdultSelection(settings, item, sources[0]);
  assert.throws(() => validateAdultSelection({ ...settings, stremio_addons: [] }, item, sources[0]), { status: 409 });
  assert.throws(() => validateAdultSelection(settings, item, { ...sources[0], source_addon_version: 'old' }), { status: 409 });
});
