const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function factory() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'movieSources.routes.cjs'), 'utf8'), {
    module, Set, Map, Date, require(name) {
      if (name === 'express') return require('express');
      if (name.includes('authJwt')) return { authJwt: (_req, _res, next) => next() };
      if (name.includes('movieSettings')) return { readMovieSettings: async () => ({ enabled: false }) };
      if (name.includes('movieResolver')) return require('../utils/movieResolver.cjs');
      if (name.includes('movieSourceSessions')) return require('../utils/movieSourceSessions.cjs');
      if (name.includes('Scraper')) return require('../utils/Scraper.cjs');
      if (name.includes('tmdbCatalog') || name.includes('animeCatalog')) return require(name);
      throw new Error('Unexpected dependency');
    },
  });
  return module.exports.createMovieSourcesRouter;
}

async function invoke(router, body = { type: 'movie', imdb_id: 'tt1234567' }) {
  const handler = router.stack[0].route.stack[1].handle;
  const response = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ device: { device_id: 1 }, body }, response);
  return response;
}

test('disabled devices cannot invoke scraper work', async () => {
  let calls = 0;
  const router = factory()({ readSettings: async () => ({ enabled: false }), discover: async () => { calls++; } });
  assert.equal((await invoke(router)).statusCode, 403);
  assert.equal(calls, 0);
});

test('source search rate-limits repeated device work and applies no-store', async () => {
  const router = factory()({ readSettings: async () => ({ enabled: true, scraper_url: 'https://example.com' }),
    discover: async () => ({ sources: [], playable: false }) });
  const first = await invoke(router);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  const next = await invoke(router);
  assert.equal(next.statusCode, 429);
  assert.equal(next.headers['Retry-After'], '10');
});

test('upstream errors never disclose scraper credentials', async () => {
  const router = factory()({ readSettings: async () => ({ enabled: true, scraper_url: 'https://example.com/?key=private' }),
    discover: async () => { throw new Error('private-secret'); } });
  const response = await invoke(router);
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.stringify(response.body).includes('private'), false);
});

test('anime source search validates TMDB classification and signs canonical metadata', async () => {
  let verified;
  const router = factory()({ readSettings: async () => ({ enabled: false, anime_enabled: true, scraper_url: 'https://example.com', tmdb_read_access_token: 'private' }),
    request: async () => ({ id: 10, original_title: 'Canonical anime', genres: [{ id: 16 }], origin_country: ['JP'], imdb_id: 'tt1234567' }),
    discover: async (_settings, metadata) => { verified = metadata; return { sources: [{ hash: 'a'.repeat(40) }] }; },
    lookup: async () => ({ available: {}, provider_status: {} }), issue: (_device, _hash, metadata) => `${metadata.section}:${metadata.tmdb_id}` });
  const response = await invoke(router, { type: 'movie', title: 'Untrusted title', section: 'anime', tmdb_id: 10 });
  assert.equal(response.statusCode, 200); assert.equal(verified.title, 'Canonical anime');
  assert.equal(response.body.sources[0].source_token, 'anime:10');
});

test('anime source search cannot bypass access or classification', async () => {
  const input = { type: 'movie', title: 'Cartoon', section: 'anime', tmdb_id: 10 };
  for (const [access, expected] of [[{ enabled: true }, 403], [{ anime_enabled: true }, 404]]) {
    const router = factory()({ readSettings: async () => ({ ...access, scraper_url: 'https://example.com', tmdb_read_access_token: 'private' }),
      request: async () => ({ genres: [{ id: 16 }], origin_country: ['US'] }),
      discover: async () => { throw new Error('Must not discover'); } });
    assert.equal((await invoke(router, input)).statusCode, expected);
  }
  assert.equal((await invoke(factory()(), { ...input, tmdb_id: undefined })).statusCode, 400);
});
