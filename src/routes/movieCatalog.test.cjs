const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function factory() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'movieCatalog.routes.cjs'), 'utf8'), {
    module, URL, AbortController, setTimeout, clearTimeout, require(name) {
      if (name === 'express') return require('express');
      if (name.includes('authJwt')) return { authJwt: (_req, _res, next) => next() };
      if (name.includes('movieSettings')) return { readMovieSettings: async () => ({ enabled: false }) };
      if (name.includes('tmdbCatalog') || name.includes('animeCatalog') || name.includes('kitsuCatalog') || name.includes('stremioCatalogs') || name.includes('streamingServices')) return require(name);
      throw new Error('Unexpected dependency');
    },
  });
  return module.exports.createMovieCatalogRouter;
}
async function invoke(options, route, query = {}, params = {}) {
  const router = factory()(options);
  const req = { device: { device_id: 7 }, query, params };
  const res = { statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
  for (const layer of router.stack.filter((value) => !value.route)) {
    let accepted = false;
    await layer.handle(req, res, () => { accepted = true; });
    if (!accepted) return res;
  }
  await router.stack.find((layer) => layer.route?.path === route).route.stack[0].handle(req, res);
  return res;
}
const configured = async () => ({ enabled: true, tmdb_read_access_token: 'private-token' });

test('streaming services require device access and metadata credentials and exclude Anime', async () => {
  const request = async () => { throw new Error('must not request'); };
  assert.equal((await invoke({ readSettings: async () => ({ enabled: false }), request }, '/movies/streaming-services')).statusCode, 403);
  assert.equal((await invoke({ readSettings: async () => ({ enabled: true }), request }, '/movies/streaming-services')).statusCode, 409);
  assert.equal((await invoke({ readSettings: async () => ({ anime_enabled: true }), request }, '/movies/streaming-services', { section: 'anime' })).statusCode, 400);
  assert.equal((await invoke({ readSettings: configured, request }, '/movies/catalog', { streaming_service: '8', addon_catalog: 'anything' })).statusCode, 400);
});

test('service routes return normalized titles and keep region internals and credentials private', async () => {
  const readSettings = async () => ({ enabled: true, tmdb_read_access_token: 'route-service-token' });
  const request = async (_settings, path) => {
    if (path === 'watch/providers/movie') return { results: [{ provider_id: 8, provider_name: 'Netflix', display_priorities: { LC: 1 } }] };
    if (path === 'watch/providers/regions') return { results: [{ iso_3166_1: 'LC' }] };
    return { total_pages: 1, results: [{ id: 10, title: 'Example', poster_path: '/poster.jpg' }] };
  };
  const list = await invoke({ readSettings, request }, '/movies/streaming-services');
  assert.equal(list.body.services[0].name, 'Netflix');
  assert.equal(list.body.services[0].regions, undefined);
  const catalog = await invoke({ readSettings, request }, '/movies/catalog', { streaming_service: '8' });
  assert.equal(catalog.body.items[0].poster, 'https://image.tmdb.org/t/p/w342/poster.jpg');
  assert.equal(JSON.stringify(catalog.body).includes('route-service-token'), false);
  assert.equal((await invoke({ readSettings, request }, '/movies/catalog', { streaming_service: '-1' })).statusCode, 400);
});

test('disabled devices and missing metadata credentials never call TMDB', async () => {
  let calls = 0;
  const request = async () => { calls++; return {}; };
  assert.equal((await invoke({ readSettings: async () => ({ enabled: false }), request }, '/movies/catalog')).statusCode, 403);
  assert.equal((await invoke({ readSettings: async () => ({ enabled: true }), request }, '/movies/catalog')).statusCode, 409);
  assert.equal(calls, 0);
});
test('movie catalog uses TMDB search, filters adult content, and never exposes settings', async () => {
  const calls = [];
  const response = await invoke({ readSettings: configured, request: async (_settings, endpoint, query) => {
    calls.push({ endpoint, query }); return { total_pages: 2, results: [{ id: 10, title: 'Example', poster_path: '/poster.jpg', release_date: '2024-01-01' }, { id: 11, adult: true }] };
  } }, '/movies/catalog', { type: 'movie', q: 'Example', page: '1' });
  assert.equal(calls[0].endpoint, 'search/movie');
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].poster, 'https://image.tmdb.org/t/p/w342/poster.jpg');
  assert.equal(JSON.stringify(response.body).includes('private-token'), false);
});
test('series details provide IMDb identity and seasons for the scraper', async () => {
  const response = await invoke({ readSettings: configured, request: async (_settings, endpoint) => {
    assert.equal(endpoint, 'tv/10'); return { id: 10, name: 'Example', external_ids: { imdb_id: 'tt1234567' }, seasons: [{ season_number: 1, name: 'Season 1' }] };
  } }, '/movies/details/:id', { type: 'series' }, { id: '10' });
  assert.equal(response.body.imdb_id, 'tt1234567');
  assert.equal(response.body.seasons[0].number, 1);
});
test('catalog rejects invalid type and never returns raw upstream errors', async () => {
  const options = { readSettings: configured, request: async () => { throw new Error('private-token'); } };
  assert.equal((await invoke(options, '/movies/catalog', { type: 'live' })).statusCode, 400);
  const response = await invoke(options, '/movies/catalog');
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.stringify(response.body).includes('private-token'), false);
});

const animeSettings = async () => ({ enabled: false, anime_enabled: true, tmdb_read_access_token: 'private-token' });
test('Anime permission is independent and legacy devices cannot browse it', async () => {
  let called = false;
  const request = async () => { called = true; return { results: [] }; };
  assert.equal((await invoke({ readSettings: configured, request }, '/movies/catalog', { section: 'anime' })).statusCode, 403);
  assert.equal(called, false);
  assert.equal((await invoke({ readSettings: animeSettings, request, animeCatalog: async () => ({ items: [] }) }, '/movies/catalog', { section: 'anime' })).statusCode, 200);
  assert.equal((await invoke({ readSettings: animeSettings, request }, '/movies/catalog')).statusCode, 403);
  assert.equal((await invoke({ readSettings: animeSettings, request }, '/movies/catalog', { section: 'unknown' })).statusCode, 400);
});

test('Anime discovery uses Kitsu without a TMDB token or request', async () => {
  const response = await invoke({ readSettings: async () => ({ anime_enabled: true }), request: async () => { throw new Error('TMDB must not be used'); }, animeCatalog: async (options) => {
    assert.equal(options.type, 'series'); assert.equal(options.category, 'top_rated');
    return { items: [{ id: 'kitsu:20', title: 'Anime', section: 'anime' }] };
  } }, '/movies/catalog', { section: 'anime', type: 'series', category: 'top_rated' });
  assert.equal(response.body.items[0].section, 'anime');
});

test('Anime search passes paging, type and query to the isolated Kitsu catalog', async () => {
  const response = await invoke({ readSettings: animeSettings, animeCatalog: async (options) => {
    assert.equal(options.query, 'Example'); assert.equal(options.type, 'movie'); assert.equal(options.page, 2);
    return { items: [{ id: 'kitsu:1' }], page: 2, total_pages: 2 };
  } }, '/movies/catalog', { section: 'anime', type: 'movie', q: 'Example', page: '2' });
  assert.equal(response.body.items[0].id, 'kitsu:1');
  assert.equal(response.body.total_pages, 2);
});

test('Kitsu details and episode routes preserve IDs without numeric coercion', async () => {
  const options = { readSettings: async () => ({ anime_enabled: true }), animeDetails: async (id, type) => {
    assert.equal(id, 'kitsu:1'); assert.equal(type, 'series');
    return { id, episodes: [{ video_id: 'kitsu:1:12', number: 12 }] };
  } };
  const details = await invoke(options, '/movies/details/:id', { section: 'anime', type: 'series' }, { id: 'kitsu:1' });
  assert.equal(details.body.id, 'kitsu:1');
  const episodes = await invoke(options, '/movies/season/:id/:season', { section: 'anime' }, { id: 'kitsu:1', season: '1' });
  assert.equal(episodes.body.episodes[0].video_id, 'kitsu:1:12');
  assert.equal((await invoke(options, '/movies/season/:id/:season', { section: 'anime' }, { id: 'kitsu:1', season: '2' })).statusCode, 404);
});

test('anime-only devices cannot request non-anime details or seasons', async () => {
  const options = { readSettings: animeSettings, request: async () => ({ id: 10, genres: [{ id: 16 }], origin_country: ['US'] }) };
  assert.equal((await invoke(options, '/movies/details/:id', { section: 'anime', type: 'series' }, { id: 10 })).statusCode, 404);
  assert.equal((await invoke(options, '/movies/season/:id/:season', { section: 'anime' }, { id: 10, season: 1 })).statusCode, 404);
});

test('configured catalog choices are accessible without TMDB but still require section access', async () => {
  const addonCatalogs = async (_settings, options) => ({ catalogs: [{ key: 'safe', name: options.section }] });
  const options = { readSettings: async () => ({ anime_enabled: true }), addonCatalogs };
  const response = await invoke(options, '/movies/addon-catalogs', { section: 'anime', type: 'series' });
  assert.equal(response.body.catalogs[0].name, 'anime');
  assert.equal((await invoke(options, '/movies/addon-catalogs', { type: 'series' })).statusCode, 403);
});
test('selected addon catalogs pass canonical scope and filters to isolated browsing', async () => {
  const response = await invoke({ readSettings: configured, addonBrowse: async (_settings, options) => {
    assert.equal(options.key, 'a'.repeat(64)); assert.equal(options.type, 'series');
    assert.equal(options.genre, 'Action'); assert.equal(options.page, 2);
    return { items: [{ id: 10 }], page: 2, total_pages: 2 };
  } }, '/movies/catalog', { type: 'series', addon_catalog: 'a'.repeat(64), genre: 'Action', page: '2' });
  assert.equal(response.body.items[0].id, 10);
});
