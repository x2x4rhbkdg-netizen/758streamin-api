const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdultCatalogClient, validateAdultSelection } = require('./adultCatalogClient.cjs');
const { createAdultAddonClient, addonVersion } = require('./adultAddons.cjs');
const { provider } = require('./thePornDb.cjs');
const { discoverSources } = require('./Scraper.cjs');
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

test('Adult opt-in reuses title/year scraper discovery, never non-Adult add-ons or metadata hashes', async () => {
  const received = [];
  const client = createAdultCatalogClient({ addons: { metadataSources: async () => [] }, discover: async (config, query) => {
    received.push({ config, query });
    return { sources: [{ hash: 'a'.repeat(40), title: 'Fixture title 2024 1080p' }, { hash: 'metadata-oshash', title: 'Reject' }] };
  } });
  const enabled = { ...settings, adult_use_shared_scrapers: true, scraper_url: 'https://pack.example/list', secondary_scraper_url: 'https://xclub.example/manifest.json' };
  assert.deepEqual(await client.sources({ ...enabled, adult_use_shared_scrapers: false }, item), []);
  assert.equal(received.length, 0);
  const sources = await client.sources(enabled, { ...item, title: 'Fixture title', year: 2024 });
  assert.equal(sources.length, 1);
  assert.deepEqual(received[0].query, { type: 'movie', title: 'Fixture title', year_int: 2024 });
  assert.deepEqual(received[0].config.stremio_addons, []);
  assert.equal(received[0].config.secondary_scraper_url, '');
  validateAdultSelection(enabled, item, sources[0]);
  assert.throws(() => validateAdultSelection({ ...enabled, adult_use_shared_scrapers: false }, item, sources[0]), { status: 409 });
  assert.throws(() => validateAdultSelection({ ...enabled, scraper_url: 'https://changed.example/list' }, item, sources[0]), { status: 409 });
  await client.sources(enabled, { ...item, title: '日本語' });
  assert.equal(received.length, 1);
});

test('Adult shared scrapers retain existing title/year matching before granting provider hashes', async () => {
  const enabled = { ...settings, adult_use_shared_scrapers: true, scraper_url: 'https://pack.example/list' };
  const client = createAdultCatalogClient({ addons: { metadataSources: async () => [] }, discover: (config, query) => discoverSources(config, query, {
    fetchText: async url => {
      if (url === enabled.scraper_url) return JSON.stringify(['https://pack.example/definition.json']);
      if (url.endsWith('definition.json')) return JSON.stringify({ name: 'Fixture', is_torrent: true, base_url: 'https://search.example',
        search_url_format_movie: { string_format: '/find?q=%s', replacement: ['title'] }, api: { path_to_array: 'results', path_hash: 'hash', path_title: 'title' } });
      return JSON.stringify({ results: [
        { hash: 'a'.repeat(40), title: 'Fixture Title 2024 1080p' },
        { hash: 'b'.repeat(40), title: 'Different Title 2024 1080p' },
        { hash: 'c'.repeat(40), title: 'Fixture Title 2023 1080p' },
      ] });
    },
  }) });
  const sources = await client.sources(enabled, { ...item, title: 'Fixture Title', year: 2024 });
  assert.deepEqual(sources.map(value => value.hash), ['a'.repeat(40)]);
});
