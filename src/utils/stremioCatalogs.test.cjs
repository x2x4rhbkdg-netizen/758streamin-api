const test = require('node:test');
const assert = require('node:assert/strict');
const { listAddonCatalogs, browseAddonCatalog } = require('./stremioCatalogs.cjs');
const { testAddon } = require('./stremioAddons.cjs');
const addon = { id: 'lists', name: '101Catalogs', enabled: true, scopes: ['movie', 'series', 'anime'], manifest_url: 'https://lists.example/private-config/manifest.json' };
const manifest = { id: 'lists', types: ['movie', 'series', '101Genres'], resources: ['catalog', 'meta'],
  catalogs: [{ id: 'movies', name: 'Apple TV+', type: 'movie', pageSize: 100, extra: [{ name: 'skip' }] },
    { id: 'genres', name: 'Best', type: '101Genres', pageSize: 100, extra: [{ name: 'skip' }, { name: 'genre', options: ['Action', 'Sci-Fi'] }] },
    { id: 'anime', name: 'Anime', type: 'series', extra: [{ name: 'search' }] }] };
function fixture(metas = []) {
  const urls = [];
  const fetchText = async (url) => { urls.push(url); return JSON.stringify(url.endsWith('manifest.json') ? manifest : { metas }); };
  const settings = { stremio_addons: [addon], tmdb_read_access_token: 'secret' };
  const request = async (_settings, path) => ({ movie_results: [{ id: Number(path.match(/\d+/)[0]), title: 'Verified', adult: false, poster_path: '/art.jpg' }], tv_results: [] });
  return { settings, fetchText, urls, request };
}
test('catalog-only manifests test successfully and list choices without exposing configuration URLs', async () => {
  const f = fixture();
  const status = await testAddon(addon, f);
  assert.equal(status.status, 'connected'); assert.equal(status.capabilities.streams, false);
  const choices = await listAddonCatalogs(f.settings, { type: 'movie' }, f);
  assert.equal(choices.catalogs.length, 2);
  assert.match(choices.catalogs[0].key, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(choices).includes('private-config'), false);
  assert.deepEqual(choices.catalogs[1].genres, ['Action', 'Sci-Fi']);
});
test('catalog pages preserve IDs via TMDB, exclude unsafe/unmapped titles and deduplicate', async () => {
  const f = fixture([{ id: 'tt1234567', name: 'Listed', type: 'movie' }, { id: 'tt1234567', name: 'Duplicate', type: 'movie' },
    { id: 'custom:id', name: 'Unsupported', type: 'movie' }, { id: 'tt7654321', name: 'Adult', type: 'movie', adult: true }]);
  const key = (await listAddonCatalogs(f.settings, { type: 'movie' }, f)).catalogs[0].key;
  const data = await browseAddonCatalog(f.settings, { type: 'movie', key }, f);
  assert.equal(data.items.length, 1); assert.equal(data.items[0].id, 1234567);
  assert.equal(data.items[0].title, 'Verified');
  assert.equal(JSON.stringify(data).includes('private-config'), false);
});
test('provider-marked safe entries still require authoritative non-adult TMDB results', async () => {
  const f = fixture([{ id: 'tt1234567', name: 'Listed', type: 'movie' }]);
  const key = (await listAddonCatalogs(f.settings, { type: 'movie' }, f)).catalogs[0].key;
  const data = await browseAddonCatalog(f.settings, { type: 'movie', key }, { ...f,
    request: async () => ({ movie_results: [{ id: 1, adult: true }] }) });
  assert.equal(data.items.length, 0);
});
test('pagination slices upstream 100-title pages into non-overlapping app pages', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => ({ id: `tt${1234500 + i}`, name: 'Title', type: 'movie' })));
  const key = (await listAddonCatalogs(f.settings, { type: 'movie' }, f)).catalogs[0].key;
  const one = await browseAddonCatalog(f.settings, { type: 'movie', key, page: 1 }, f);
  const two = await browseAddonCatalog(f.settings, { type: 'movie', key, page: 2 }, f);
  assert.equal(one.items.length, 20); assert.equal(two.items.length, 20);
  assert.equal(one.items.some((a) => two.items.some((b) => a.id === b.id)), false);
  await browseAddonCatalog(f.settings, { type: 'movie', key, page: 6 }, f);
  assert.match(f.urls.at(-1), /skip=100.json$/);
});
test('custom catalog type and genre are encoded and revalidated against configured manifest', async () => {
  const f = fixture();
  const key = (await listAddonCatalogs(f.settings, { type: 'movie' }, f)).catalogs[1].key;
  await browseAddonCatalog(f.settings, { type: 'movie', key, genre: 'Sci-Fi' }, f);
  assert.match(f.urls.at(-1), /catalog\/101Genres\/genres\/skip=0&genre=Sci-Fi.json$/);
  await assert.rejects(browseAddonCatalog(f.settings, { type: 'movie', key, genre: '../secret' }, f), { status: 400 });
  await assert.rejects(browseAddonCatalog({ ...f.settings, stremio_addons: [] }, { type: 'movie', key }, f), { status: 404 });
  await assert.rejects(browseAddonCatalog(f.settings, { type: 'movie', key: 'https://localhost/' }, f), { status: 400 });
});
test('Adult, disabled and out-of-scope add-ons are never fetched for normal catalogs', async () => {
  const f = fixture();
  f.settings.stremio_addons = [{ ...addon, scopes: ['adult', 'movie'] }, { ...addon, enabled: false }, { ...addon, scopes: ['anime'] }];
  assert.deepEqual(await listAddonCatalogs(f.settings, { type: 'movie' }, f), { catalogs: [] });
  assert.equal(f.urls.length, 0);
});
test('Kitsu lists keep identity and safety checks without TMDB, IMDb Anime requires verified Japanese animation', async () => {
  const f = fixture([{ id: 'kitsu:1', name: 'Kitsu anime', type: 'series' }, { id: 'kitsu:2', name: 'Unsafe', type: 'series' },
    { id: 'tt1234567', name: 'IMDb anime', type: 'series' }]);
  const key = (await listAddonCatalogs(f.settings, { type: 'series', section: 'anime' }, f)).catalogs.find((c) => c.name === 'Anime').key;
  const options = { type: 'series', section: 'anime', key };
  const deps = { ...f, checkAnime: async () => new Set(['kitsu:1']), request: async () => ({ tv_results: [
    { id: 10, name: 'Verified Anime', adult: false, genre_ids: [16], origin_country: ['JP'] }] }) };
  const data = await browseAddonCatalog(f.settings, options, deps);
  assert.deepEqual(data.items.map((m) => m.id), ['kitsu:1', 10]);
  const noToken = await browseAddonCatalog({ ...f.settings, tmdb_read_access_token: '' }, options, deps);
  assert.deepEqual(noToken.items.map((m) => m.id), ['kitsu:1']);
});

test('Anime movie country checks use full TMDB details when IMDb find omits production countries', async () => {
  const f = fixture([{ id: 'tt1234567', name: 'Anime movie', type: 'movie' }]);
  const key = (await listAddonCatalogs(f.settings, { type: 'movie', section: 'anime' }, f)).catalogs[0].key;
  const data = await browseAddonCatalog(f.settings, { type: 'movie', section: 'anime', key }, { ...f,
    checkAnime: async () => new Set(), request: async (_settings, endpoint) => endpoint.startsWith('find/')
      ? { movie_results: [{ id: 10, title: 'Anime movie', adult: false, genre_ids: [16] }] }
      : { id: 10, adult: false, genres: [{ id: 16 }], production_countries: [{ iso_3166_1: 'JP' }] } });
  assert.equal(data.items[0].id, 10); assert.equal(data.items[0].section, 'anime');
});

test('catalog browsing never guesses unsupported IDs or sends a request to a user-supplied URL', async () => {
  const f = fixture([{ id: 'https://localhost/secret', name: 'Invalid', type: 'movie' }]);
  const key = (await listAddonCatalogs(f.settings, { type: 'movie' }, f)).catalogs[0].key;
  const data = await browseAddonCatalog(f.settings, { type: 'movie', key }, { ...f, request: async () => assert.fail('No metadata request expected') });
  assert.equal(data.items.length, 0);
});

test('catalogs respect supported search and required genre fields', async () => {
  const f = fixture();
  const key = (await listAddonCatalogs(f.settings, { type: 'movie' }, f)).catalogs[0].key;
  await assert.rejects(browseAddonCatalog(f.settings, { type: 'movie', key, query: 'Title' }, f), { status: 400 });
  const fetchText = async (url) => JSON.stringify(url.endsWith('manifest.json') ? { ...manifest,
    catalogs: [{ type: 'movie', id: 'required', extra: [{ name: 'genre', isRequired: true, options: ['Action'] }] }] } : { metas: [] });
  const requiredKey = (await listAddonCatalogs(f.settings, { type: 'movie' }, { fetchText })).catalogs[0].key;
  const data = await browseAddonCatalog(f.settings, { type: 'movie', key: requiredKey }, { fetchText });
  assert.match(data.notice, /Choose a genre/);
});
