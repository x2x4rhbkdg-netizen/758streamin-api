const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createSourceCapabilities } = require('../utils/movieSourceSessions.cjs');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');

function fixture(settings) {
  let handler, resolutions = 0;
  const capabilities = createSourceCapabilities('test-secret');
  const context = { module: { exports: {} }, URL, process: { env: { JWT_SECRET: 'test-secret' } }, require(name) {
    if (name === 'express') return { Router: () => ({ post(_path, _auth, callback) { handler = callback; } }) };
    if (name.includes('authJwt')) return { authJwt() {} };
    if (name.includes('movieSettings')) return { readMovieSettings: async () => settings };
    if (name.includes('movieResolver')) return { resolveMovieSource: async () => {
      resolutions++; return { provider: 'Premiumize', protectedPlaybackUrl: 'https://cdn.example/anime.mp4' };
    } };
    if (name.includes('movieSourceSessions')) return capabilities;
    if (name.includes('moviePlaybackTickets')) return { createPlaybackTickets };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('./moviePlayback.routes.cjs'), 'utf8'), context);
  return { capabilities, async run(body) {
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ device: { device_id: 1 }, body }, res);
    return { code: res.code, body: res.body, resolutions };
  } };
}

test('playback access comes from signed Anime scope, not editable request fields', async () => {
  const hash = 'a'.repeat(40);
  const allowed = fixture({ enabled: false, anime_enabled: true });
  const source_token = allowed.capabilities.issueSource(1, hash, { type: 'movie', section: 'anime', tmdb_id: 10 });
  const result = await allowed.run({ type: 'movie', hash, source_token, provider: 'Premiumize', section: 'movies' });
  assert.equal(result.code, 200); assert.equal(result.resolutions, 1);
  const ticket = new URL(result.body.playbackUrl).pathname.split('/').pop();
  assert.equal(createPlaybackTickets('test-secret').read(ticket).section, 'anime');
  const denied = fixture({ enabled: true, anime_enabled: false });
  assert.equal((await denied.run({ type: 'movie', hash, source_token })).code, 403);
  const ordinary = allowed.capabilities.issueSource(1, hash, { type: 'movie' });
  const bypass = await allowed.run({ type: 'movie', hash, source_token: ordinary, section: 'anime' });
  assert.equal(bypass.code, 403); assert.equal(bypass.resolutions, 1);
});
