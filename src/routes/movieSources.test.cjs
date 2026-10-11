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
      if (name.includes('Scraper')) return require('../utils/Scraper.cjs');
      throw new Error('Unexpected dependency');
    },
  });
  return module.exports.createMovieSourcesRouter;
}

async function invoke(router) {
  const handler = router.stack[0].route.stack[1].handle;
  const response = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ device: { device_id: 1 }, body: { type: 'movie', imdb_id: 'tt1234567' } }, response);
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
