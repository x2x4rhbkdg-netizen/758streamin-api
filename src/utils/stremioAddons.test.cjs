const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAddons, publicAddons, discoverAddons, testAddon, supports } = require('./stremioAddons.cjs');
const { discoverSources } = require('./Scraper.cjs');
const hash = 'a'.repeat(40), other = 'b'.repeat(40);
const addon = (id, scopes = ['movie', 'series', 'anime']) => ({ id, name: id, enabled: true, scopes, manifest_url: `https://${id}.example/secret/manifest.json` });
const manifest = { id: 'org.fixture', types: ['movie', 'series'], resources: ['stream'], idPrefixes: ['tt'] };
test('Adult add-ons can be enabled independently and cannot mix with general media', () => {
  const pending = { ...addon('adult-rd', ['adult']), enabled: false,
    manifest_url: 'https://adult-rd-bov3.vercel.app/manifest.json' };
  assert.deepEqual(normalizeAddons([pending]), [pending]);
  assert.equal(normalizeAddons([{ ...pending, enabled: true }])[0].enabled, true);
  assert.throws(() => normalizeAddons([{ ...pending, scopes: ['adult', 'movie'] }]), { status: 400 });
  assert.equal(normalizeAddons(publicAddons([pending]), [pending])[0].manifest_url, pending.manifest_url);
});
test('Adult entries never participate in general discovery even with malformed stored scopes', async () => {
  let calls = 0;
  const result = await discoverAddons({ stremio_addons: [addon('adult', ['adult', 'movie'])] },
    { type: 'movie', imdb_id: 'tt1234567' }, { fetchText: async () => { calls++; return JSON.stringify(manifest); } });
  assert.equal(calls, 0);
  assert.deepEqual(result, { sources: [], diagnostics: [] });
});
test('Adult connection tests require catalog and stream resources', async () => {
  const pending = addon('adult', ['adult']);
  assert.equal((await testAddon(pending, { fetchText: async () => JSON.stringify(manifest) })).status, 'unsupported');
  assert.equal((await testAddon(pending, { fetchText: async () => JSON.stringify({ ...manifest, resources: ['catalog', 'stream'], catalogs: [{ id: 'fixture', type: 'movie' }] }) })).status, 'connected');
  assert.equal((await testAddon(pending, { fetchText: async () => '{}' })).status, 'unsupported');
  assert.equal((await testAddon(pending, { fetchText: async () => { throw new Error('404'); } })).status, 'unavailable');
});

test('Adult manifest tests accept custom catalog types and explain the actual missing resource', async () => {
  const configured = addon('adult', ['adult']);
  const custom = { id: 'fixture', types: ['hanime'], resources: ['catalog', 'meta', 'stream'],
    catalogs: [{ id: 'fixture', type: 'hanime' }] };
  assert.equal((await testAddon(configured, { fetchText: async () => JSON.stringify(custom) })).status, 'connected');
  for (const missing of ['catalog', 'stream']) {
    const result = await testAddon(configured, { fetchText: async () => JSON.stringify({ ...custom, resources: custom.resources.filter((name) => name !== missing) }) });
    assert.equal(result.status, 'unsupported');
    assert.match(result.message, new RegExp(`no ${missing} resource`));
  }
});
test('validates bounds, identifiers, scopes and HTTPS manifest URLs', () => {
  const good = addon('one');
  assert.equal(normalizeAddons([good])[0].manifest_url, good.manifest_url);
  const { manifest_url, ...masked } = good;
  assert.equal(normalizeAddons([masked], [good])[0].manifest_url, manifest_url);
});

test('Adult connection test accepts separate catalog and stream type declarations', async () => {
  const mixed = { id: 'fixture', types: ['porn'], resources: [
    { name: 'catalog', types: ['porn'] }, { name: 'meta', types: ['movie'] }, { name: 'stream', types: ['movie'] },
  ], catalogs: [{ id: 'recent', type: 'porn' }] };
  const result = await testAddon(addon('fixture', ['adult']), { fetchText: async () => JSON.stringify(mixed) });
  assert.equal(result.status, 'connected');
  const unsupported = await testAddon(addon('fixture', ['adult']), { fetchText: async () => JSON.stringify({ ...mixed,
    catalogs: [{ id: 'filtered', type: 'porn', extra: [{ name: 'genre', isRequired: true }] }] }) });
  assert.equal(unsupported.status, 'unsupported');
});
test('rejects invalid, duplicate and oversized settings', () => {
  const good = addon('one');
  for (const input of [null, {}, Array.from({ length: 11 }, (_, i) => addon(`a${i}`)), [good, good],
    [{ ...good, scopes: [] }], [{ ...good, scopes: ['live'] }], [{ ...good, enabled: 'true' }],
    [{ ...good, manifest_url: 'http://one.example/manifest.json' }], [{ ...good, manifest_url: 'file:///manifest.json' }],
    [{ ...good, manifest_url: 'https://user:password@one.example/manifest.json' }],
    [{ ...good, manifest_url: 'https://one.example:3306/manifest.json' }], [{ ...good, manifest_url: 'https://one.example/manifest.json?token=secret' }],
    [good, { ...addon('two'), manifest_url: good.manifest_url }]]) assert.throws(() => normalizeAddons(input), { status: 400 });
});
test('masked URLs survive roundtrip edits and cannot leak through public summaries', () => {
  const saved = addon('one');
  const masked = publicAddons([saved]);
  assert.equal(JSON.stringify(masked).includes('secret'), false);
  assert.equal(normalizeAddons([{ ...masked[0], enabled: false }], [saved])[0].manifest_url, saved.manifest_url);
  assert.throws(() => normalizeAddons(masked), { status: 400 });
  assert.deepEqual(normalizeAddons([], [saved]), []);
});
test('manifest matching honors resource types and ID prefixes', () => {
  assert.equal(supports(manifest, 'movie', 'tt1234567'), true);
  assert.equal(supports({ ...manifest, resources: ['catalog'] }, 'movie', 'tt1234567'), false);
  assert.equal(supports({ ...manifest, resources: [{ name: 'stream', types: ['series'], idPrefixes: ['kitsu:'] }] }, 'series', 'tt1234567:1:1'), false);
});
test('multiple add-ons merge while failing and unsupported add-ons remain isolated', async () => {
  const fetchText = async (url) => {
    if (url.includes('broken.example')) throw new Error('secret URL error');
    if (url.endsWith('manifest.json')) return JSON.stringify(manifest);
    return JSON.stringify({ streams: [{ infoHash: hash.toUpperCase(), name: '4K', title: 'Fixture', behaviorHints: { videoSize: 1000000000 } },
      { url: 'https://stream.example/secret.mp4' }, { externalUrl: 'https://external.example' }, { infoHash: 'not-a-hash' }] });
  };
  const result = await discoverAddons({ stremio_addons: [addon('one'), addon('two'), addon('broken')] }, { type: 'movie', imdb_id: 'tt1234567' }, { fetchText });
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].hash, hash);
  assert.equal(result.sources[0].quality, '2160p');
  assert.equal(result.diagnostics[0].unsupported, 3);
  assert.equal(result.diagnostics[2].status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('disabled and out-of-scope add-ons make no requests; anime is independent', async () => {
  const urls = [];
  const fetchText = async (url) => { urls.push(url); return JSON.stringify(url.endsWith('manifest.json') ? manifest : { streams: [] }); };
  const settings = { stremio_addons: [{ ...addon('off'), enabled: false }, addon('movies', ['movie']), addon('anime', ['anime'])] };
  await discoverAddons(settings, { type: 'series', section: 'anime', imdb_id: 'tt1234567', season_int: 2, episode_int: 3 }, { fetchText });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /anime.example\/secret\/stream\/series\/tt1234567%3A2%3A3.json$/);
});
test('connection tests return safe statuses and never echo manifest credentials', async () => {
  assert.equal((await testAddon(addon('one'), { fetchText: async () => JSON.stringify(manifest) })).status, 'connected');
  assert.equal((await testAddon(addon('one'), { fetchText: async () => JSON.stringify({ ...manifest, resources: ['catalog'] }) })).status, 'unsupported');
  const failed = await testAddon(addon('one'), { fetchText: async () => { throw new Error('secret'); } });
  assert.equal(failed.status, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
});
test('add-on searches work without a scraper and apply exclusions and bitrate filtering', async () => {
  const fetchText = async (url) => JSON.stringify(url.endsWith('manifest.json') ? manifest : { streams: [
    { infoHash: hash, title: 'Fixture CAM' }, { infoHash: other, title: 'Fixture 1080p', behaviorHints: { videoSize: 1000000000 } },
  ] });
  const settings = { stremio_addons: [addon('one'), addon('two')], hide_phrases: 'CAM', max_bitrate_mbps: 20 };
  const result = await discoverSources(settings, { type: 'movie', imdb_id: 'tt1234567', title: 'Different localized title', year_int: 2001, duration_seconds: 1000 }, { fetchText });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].hash, other);
  assert.equal(result.sources[0].bitrate_mbps, 8);
  const filtered = await discoverSources({ ...settings, max_bitrate_mbps: 5 }, { type: 'movie', imdb_id: 'tt1234567', duration_seconds: 1000 }, { fetchText });
  assert.equal(filtered.sources.length, 0);
});
test('bad legacy scraper manifest does not discard add-on results', async () => {
  const fetchText = async (url) => {
    if (url.includes('bad.example')) throw new Error('broken');
    return JSON.stringify(url.endsWith('manifest.json') ? manifest : { streams: [{ infoHash: hash, title: 'Fixture' }] });
  };
  const result = await discoverSources({ scraper_url: 'https://bad.example', stremio_addons: [addon('one')] }, { type: 'movie', imdb_id: 'tt1234567' }, { fetchText });
  assert.equal(result.sources.length, 1);
  assert.equal(result.diagnostics.definition_errors, 1);
});
test('concurrency is bounded to four add-ons', async () => {
  let active = 0, peak = 0;
  const fetchText = async (url) => {
    active++; peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    return JSON.stringify(url.endsWith('manifest.json') ? manifest : { streams: [] });
  };
  await discoverAddons({ stremio_addons: Array.from({ length: 10 }, (_, i) => addon(`a${i}`)) }, { type: 'movie', imdb_id: 'tt1234567' }, { fetchText });
  assert.equal(peak, 4);
});
