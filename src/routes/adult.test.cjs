const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAdultTokens } = require('../utils/adultAccess.cjs');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { addonVersion } = require('../utils/adultAddons.cjs');

function fixture(overrides = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./adult.routes.cjs'), 'utf8'), {
    module, Buffer, URL, process: { env: { JWT_SECRET: 'test-secret' } }, require(name) {
      if (name === '../middleware/authJwt.cjs') return { authJwt: (_req, _res, next) => next() };
      if (name === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({}) };
      return require(name);
    },
  });
  const settings = { adult_enabled: true, stremio_addons: [{ id: 'adult', enabled: true, scopes: ['adult'] }] };
  let pin = { pin: '1234', fingerprint: 'pin-one' }, time = 1000;
  const tokens = createAdultTokens('test-secret', () => time);
  const tickets = createPlaybackTickets('test-secret');
  const calls = [];
  const historyRecords = new Map();
  const historyOwners = { 1: 'account-a', 2: 'account-a', 3: 'account-b' };
  const router = module.exports.createAdultRouter({ readSettings: async () => settings, readPin: async () => pin,
    tokens: () => tokens, tickets: () => tickets, now: () => time,
    history: { owner: async device => historyOwners[device],
      list: async owner => [...historyRecords.values()].filter(record => record.owner === owner).map(record => record.entry),
      put: async (owner, section, key, entry) => { historyRecords.set(`${owner}:${key}`, { owner, entry }); } },
    client: { catalogs: async () => ({ catalogs: [{ id: 'fixture' }] }),
      catalog: async () => ({ items: [{ id: 'custom:1', addon_id: 'adult', addon_version: addonVersion(settings.stremio_addons[0]), type: 'movie', title: 'Fixture', poster: 'https://cdn.example/poster.jpg?key=private' }] }),
      details: async (_settings, item) => ({ ...item, videos: [] }),
      sources: async () => [{ title: 'Fixture file', url: 'https://cdn.example/file.mp4?key=private' }] },
    lookup: async () => ({ available: {} }),
    resolve: async (_settings, input) => { calls.push(input); return { provider: 'Torbox', protectedPlaybackUrl: 'https://cdn.example/file.mp4?key=private' }; },
    ...overrides });
  async function invoke(action, body = {}, device = 1) {
    const route = router.stack.find((entry) => entry.route?.path === `/adult/${action}`).route;
    const res = { code: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await route.stack.at(-1).handle({ body, device: { device_id: device } }, res);
    return res;
  }
  const unlock = async (device = 1) => (await invoke('unlock', { pin: '1234' }, device)).body.unlock_token;
  return { invoke, unlock, settings, tokens, tickets, calls, historyOwners, historyRecords, setPin: (value) => { pin = value; }, advance: (ms) => { time += ms; } };
}
test('Adult history restores only after PIN unlock on another linked device', async () => {
  const f = fixture();
  const unlock_token = await f.unlock();
  const catalog = await f.invoke('catalog', { unlock_token });
  const sources = await f.invoke('sources', { unlock_token, item_token: catalog.body.items[0].item_token });
  const playback = await f.invoke('resolve', { unlock_token, source_token: sources.body.sources[0].source_token });
  assert.equal(playback.code, 200);
  const history_progress_token = playback.body.history_progress_token;
  assert.ok(history_progress_token);
  assert.equal((await f.invoke('progress', { history_progress_token, position: 60, duration: 1000, updatedAt: 1000 })).code, 200);
  const request = { addon_id: '__history', catalog_id: '__history' };
  assert.equal((await f.invoke('catalog', request, 2)).code, 403);
  const second = await f.unlock(2);
  const restored = await f.invoke('catalog', { ...request, unlock_token: second }, 2);
  assert.equal(restored.body.items[0].resume_position, 60);
  assert.ok(restored.body.items[0].item_token);
  assert.equal((await f.invoke('catalog', { ...request, unlock_token: await f.unlock(3) }, 3)).body.items.length, 0);
  assert.equal((await f.invoke('progress', { history_progress_token, position: 80, duration: 1000, updatedAt: 1000 }, 2)).code, 403);
});
test('selected-title progress grant cannot browse and is revoked by account/PIN changes', async () => {
  const f = fixture();
  const unlock_token = await f.unlock();
  const catalog = await f.invoke('catalog', { unlock_token });
  const sources = await f.invoke('sources', { unlock_token, item_token: catalog.body.items[0].item_token });
  const playback = await f.invoke('resolve', { unlock_token, source_token: sources.body.sources[0].source_token });
  const history_progress_token = playback.body.history_progress_token;
  assert.equal((await f.invoke('catalogs', { unlock_token: history_progress_token })).code, 403);
  f.historyOwners[1] = 'account-b';
  assert.equal((await f.invoke('progress', { history_progress_token, position: 60, duration: 1000, updatedAt: 1000 })).code, 409);
  f.setPin({ pin: '5678', fingerprint: 'changed' });
  assert.equal((await f.invoke('progress', { history_progress_token, position: 60, duration: 1000, updatedAt: 1000 })).code, 403);
});
test('Adult is disabled independently of Movies and PIN unlock is rate limited', async () => {
  const f = fixture();
  f.settings.adult_enabled = false; f.settings.enabled = true;
  assert.equal((await f.invoke('unlock', { pin: '1234' })).code, 403);
  f.settings.adult_enabled = true;
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await f.invoke('unlock', { pin: '9999' })).code, 403);
  assert.equal((await f.invoke('unlock', { pin: '1234' })).code, 429);
  f.advance(5 * 60000);
  assert.equal((await f.invoke('unlock', { pin: '1234' })).code, 200);
});
test('catalog requests require server unlock, correct device and unchanged PIN', async () => {
  const f = fixture();
  assert.equal((await f.invoke('catalogs')).code, 403);
  const unlock_token = await f.unlock();
  assert.equal((await f.invoke('catalogs', { unlock_token })).code, 200);
  assert.equal((await f.invoke('catalogs', { unlock_token }, 2)).code, 403);
  f.setPin({ pin: '5678', fingerprint: 'pin-two' });
  assert.equal((await f.invoke('catalogs', { unlock_token })).code, 403);
  f.setPin(null);
  assert.equal((await f.invoke('catalogs', { unlock_token })).code, 409);
});
test('unlock expiry prevents browsing and capabilities cannot be swapped by purpose', async () => {
  const f = fixture();
  const unlock_token = await f.unlock();
  assert.equal((await f.invoke('details', { unlock_token, item_token: unlock_token })).code, 403);
  f.advance(15 * 60000);
  assert.equal((await f.invoke('catalogs', { unlock_token })).code, 403);
});
test('catalog to source to direct playback hides upstream secrets and binds the Adult PIN', async () => {
  const f = fixture();
  const unlock_token = await f.unlock();
  const catalog = await f.invoke('catalog', { unlock_token });
  assert.equal(catalog.headers['Cache-Control'], 'private, no-store');
  assert.equal(catalog.body.items[0].id, undefined);
  assert.equal(catalog.body.items[0].poster_url.includes('private'), false);
  const item_token = catalog.body.items[0].item_token;
  const sources = await f.invoke('sources', { unlock_token, item_token });
  assert.equal(JSON.stringify(sources.body).includes('private'), false);
  assert.equal(sources.body.sources[0].url, undefined);
  const source_token = sources.body.sources[0].source_token;
  const result = await f.invoke('resolve', { unlock_token, source_token, url: 'http://127.0.0.1/ignored' });
  assert.equal(result.code, 200);
  assert.equal(f.calls.length, 0);
  const ticket = result.body.playbackUrl.split('/').at(-1);
  const record = f.tickets.read(ticket);
  assert.equal(record.url, 'https://cdn.example/file.mp4?key=private');
  assert.equal(record.section, 'adult');
  assert.equal(record.adultPinFingerprint, 'pin-one');
  assert.equal(record.device, '1');
  assert.equal((await f.invoke('resolve', { unlock_token, source_token: `${source_token}x` })).code, 403);
  f.settings.stremio_addons[0].manifest_url = 'https://changed.example/manifest.json';
  assert.equal((await f.invoke('resolve', { unlock_token, source_token })).code, 409);
  f.settings.stremio_addons[0].enabled = false;
  assert.equal((await f.invoke('resolve', { unlock_token, source_token })).code, 409);
});
test('only the selected signed hash is resolved; manual Real-Debrid preparation is opt-in', async () => {
  const f = fixture();
  const unlock_token = await f.unlock();
  const source_token = f.tokens.issue('source', 1, { fingerprint: 'pin-one', item: { addon_id: 'adult', addon_version: addonVersion(f.settings.stremio_addons[0]), type: 'movie' },
    source: { hash: 'a'.repeat(40), file_name: 'movie.mp4' } });
  const result = await f.invoke('resolve', { unlock_token, source_token, hash: 'b'.repeat(40) });
  assert.equal(result.code, 200);
  assert.equal(f.calls[0].hash, 'a'.repeat(40));
  assert.equal(f.calls[0].section, 'adult');
  assert.equal(f.calls[0].provider, 'auto');
  assert.equal(f.calls[0].allow_uncached_rd, false);
  await f.invoke('resolve', { unlock_token, source_token, allow_uncached_rd: true });
  assert.equal(f.calls[1].allow_uncached_rd, true);
});
test('unmapped series sources fail instead of choosing an arbitrary episode', async () => {
  const f = fixture();
  const unlock_token = await f.unlock();
  const source_token = f.tokens.issue('source', 1, { fingerprint: 'pin-one', item: { addon_id: 'adult', addon_version: addonVersion(f.settings.stremio_addons[0]), type: 'series' }, source: { hash: 'a'.repeat(40) } });
  assert.equal((await f.invoke('resolve', { unlock_token, source_token })).code, 409);
  assert.equal(f.calls.length, 0);
});
