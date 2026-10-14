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
      if (name.includes('tmdbCatalog') || name.includes('animeCatalog')) return require(name);
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
  assert.equal((await invoke({ readSettings: animeSettings, request }, '/movies/catalog', { section: 'anime' })).statusCode, 200);
  assert.equal((await invoke({ readSettings: animeSettings, request }, '/movies/catalog')).statusCode, 403);
  assert.equal((await invoke({ readSettings: animeSettings, request }, '/movies/catalog', { section: 'unknown' })).statusCode, 400);
});

test('anime discovery uses Animation AND Japan with rating safeguards', async () => {
  const response = await invoke({ readSettings: animeSettings, request: async (_settings, endpoint, params) => {
    assert.equal(endpoint, 'discover/tv');
    assert.equal(params.with_genres, '16'); assert.equal(params.with_origin_country, 'JP');
    assert.equal(params.sort_by, 'vote_average.desc'); assert.equal(params['vote_count.gte'], 100);
    return { results: [{ id: 20, name: 'Anime' }] };
  } }, '/movies/catalog', { section: 'anime', type: 'series', category: 'top_rated' });
  assert.equal(response.body.items[0].section, 'anime');
});

test('anime search verifies movie country/genre and excludes cartoons, live action, and adults', async () => {
  const titles = [
    { id: 1, genres: [{ id: 16 }], production_countries: [{ iso_3166_1: 'JP' }] },
    { id: 2, genres: [{ id: 16 }], production_countries: [{ iso_3166_1: 'US' }] },
    { id: 3, genres: [{ id: 18 }], production_countries: [{ iso_3166_1: 'JP' }] },
    { id: 4, adult: true, genres: [{ id: 16 }], production_countries: [{ iso_3166_1: 'JP' }] },
  ];
  const response = await invoke({ readSettings: animeSettings, request: async (_settings, endpoint) =>
    endpoint === 'search/movie' ? { total_pages: 3, results: titles.map((title) => ({ id: title.id, genre_ids: [16] })) }
      : titles[Number(endpoint.split('/')[1]) - 1] }, '/movies/catalog', { section: 'anime', type: 'movie', q: 'Example' });
  assert.deepEqual(Array.from(response.body.items, (value) => value.id), [1]);
  assert.equal(response.body.total_pages, 3);
});

test('anime-only devices cannot request non-anime details or seasons', async () => {
  const options = { readSettings: animeSettings, request: async () => ({ id: 10, genres: [{ id: 16 }], origin_country: ['US'] }) };
  assert.equal((await invoke(options, '/movies/details/:id', { section: 'anime', type: 'series' }, { id: 10 })).statusCode, 404);
  assert.equal((await invoke(options, '/movies/season/:id/:season', { section: 'anime' }, { id: 10, season: 1 })).statusCode, 404);
});
