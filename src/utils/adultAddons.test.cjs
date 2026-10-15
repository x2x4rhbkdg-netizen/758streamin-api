const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdultTokens } = require('./adultAccess.cjs');
const { createAdultAddonClient, addonVersion } = require('./adultAddons.cjs');
const { chooseVideo } = require('./movieResolver.cjs');
const settings = { stremio_addons: [{ id: 'adult', name: 'Fixture', scopes: ['adult'], enabled: true,
  manifest_url: 'https://fixture.example/private-key/manifest.json' }] };
const manifest = { id: 'fixture', types: ['movie', 'series'], resources: ['catalog', 'meta', 'stream'], idPrefixes: ['fixture:'],
  catalogs: [{ id: 'catalog', type: 'movie', extra: [{ name: 'search' }, { name: 'skip' }] }] };
test('Adult capabilities are encrypted, device/purpose bound, tamper resistant and expire', () => {
  let time = 1000;
  const caps = createAdultTokens('secret', () => time);
  const token = caps.issue('source', 1, { url: 'https://cdn.example/movie.mp4?token=private-key' }, 100);
  assert.equal(token.includes('private-key'), false);
  assert.equal(caps.read(token, 'source', 1).url.includes('private-key'), true);
  for (const [value, purpose, device] of [[token, 'unlock', 1], [token, 'source', 2], [`x${token}`, 'source', 1]]) {
    assert.throws(() => caps.read(value, purpose, device), { status: 403 });
  }
  time = 1100;
  assert.throws(() => caps.read(token, 'source', 1), { status: 403 });
});
test('Adult catalog uses add-on identifiers, pagination and search without TMDB', async () => {
  const urls = [];
  const client = createAdultAddonClient({ fetchText: async (url) => {
    urls.push(url);
    return JSON.stringify(url.endsWith('manifest.json') ? manifest : { metas: [{ id: 'fixture:1', name: 'Fixture movie' }] });
  } });
  const catalogs = await client.catalogs(settings);
  assert.equal(catalogs.catalogs[0].addon_id, 'adult');
  const response = await client.catalog(settings, { addon_id: 'adult', catalog_id: 'catalog', type: 'movie', page: 2, query: 'a/b' });
  assert.equal(response.items[0].id, 'fixture:1');
  assert.match(urls.at(-1), /catalog\/movie\/catalog\/search=a%2Fb&skip=100.json$/);
  await assert.rejects(client.catalog(settings, { addon_id: 'other', catalog_id: 'catalog', type: 'movie' }), { status: 409 });
});
test('Adult add-ons are exclusive and unreachable manifest errors never disclose URLs', async () => {
  let calls = 0;
  const client = createAdultAddonClient({ fetchText: async () => { calls++; throw new Error('private-key'); } });
  await assert.rejects(client.catalogs({ stremio_addons: [{ ...settings.stremio_addons[0], scopes: ['movie'] }] }), { status: 409 });
  assert.equal(calls, 0);
  await assert.rejects(client.catalogs(settings), (error) => error.status === 502 && !error.message.includes('private-key'));
});
test('streams accept provider hashes and HTTPS files but skip unsupported formats', async () => {
  const client = createAdultAddonClient({ fetchText: async (url) => JSON.stringify(url.endsWith('manifest.json') ? manifest : {
    streams: [{ infoHash: 'a'.repeat(40), behaviorHints: { filename: 'movie.mp4' } },
      { url: 'https://cdn.example/movie.mp4?token=secret' }, { url: 'http://cdn.example/movie.mp4' },
      { url: 'https://cdn.example/movie.m3u8' }, { externalUrl: 'https://external.example/' },
      { url: 'https://cdn.example/movie.mp4', behaviorHints: { proxyHeaders: { request: { Authorization: 'secret' } } } }],
  }) });
  const identity = { addon_id: 'adult', addon_version: addonVersion(settings.stremio_addons[0]) };
  const sources = await client.sources(settings, { ...identity, id: 'fixture:1', type: 'movie' });
  assert.equal(sources.length, 3);
  assert.equal(sources[0].hash, 'a'.repeat(40));
  assert.equal(sources[0].file_name, 'movie.mp4');
  assert.equal(sources[1].url, 'https://cdn.example/movie.mp4?token=secret');
  await assert.rejects(client.sources(settings, { ...identity, id: 'tt1234567', type: 'movie' }), { status: 409 });
  await assert.rejects(client.sources(settings, { ...identity, addon_version: 'old', id: 'fixture:1', type: 'movie' }), { status: 409 });
});
test('series use exact released video IDs, without guessing season numbering', async () => {
  const client = createAdultAddonClient({ fetchText: async (url) => JSON.stringify(url.endsWith('manifest.json') ? manifest : {
    meta: { id: 'fixture:series', videos: [{ id: 'fixture:series:2', title: 'Episode', season: 2, episode: 3 },
      { id: 'fixture:future', released: '2999-01-01' }] },
  }) });
  const result = await client.details(settings, { addon_id: 'adult', addon_version: addonVersion(settings.stremio_addons[0]), id: 'fixture:series', type: 'series' });
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].id, 'fixture:series:2');
  assert.equal(result.videos[0].episode, 3);
});

test('provider resolution honors the signed filename instead of a larger different file', () => {
  const files = [{ path: 'folder/chosen.mp4', bytes: 10 }, { path: 'other.mp4', bytes: 100 }];
  assert.equal(chooseVideo(files, { section: 'adult', type: 'movie', file_name: 'chosen.mp4' }).path, 'folder/chosen.mp4');
  assert.throws(() => chooseVideo(files, { section: 'adult', type: 'movie', file_name: 'missing.mp4' }), { status: 409 });
});
