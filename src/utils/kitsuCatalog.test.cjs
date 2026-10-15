const test = require('node:test');
const assert = require('node:assert/strict');
const { kitsuCatalog, kitsuDetails, canonicalKitsuSearch } = require('./kitsuCatalog.cjs');
const { validateSearch, discoverSources } = require('./Scraper.cjs');
const { chooseVideo } = require('./movieResolver.cjs');
const { createSourceCapabilities } = require('./movieSourceSessions.cjs');
const meta = { id: 'kitsu:1', type: 'series', name: 'Fixture Anime', description: 'Description', runtime: '24 min',
  genres: ['Action'], poster: 'https://example.com/poster.jpg',
  videos: [{ id: 'kitsu:1:12', title: 'Twelve', episode: 1, season: 3, imdbSeason: 3, imdbEpisode: 1,
    released: '2020-01-01', overview: 'Episode description' }, { id: 'kitsu:1:13', title: 'Thirteen', released: '2020-01-08' }] };
const safe = { data: [{ id: '1', attributes: { ageRating: 'PG', nsfw: false } }] };
const fetchText = async (url) => JSON.stringify(url.startsWith('https://kitsu.io/') ? safe : url.includes('/catalog/') ? { metas: [meta] } : { meta });

test('Kitsu catalog keeps namespaced identity and routes search/category/paging', async () => {
  const urls = [];
  const options = { fetchText: async (url) => { urls.push(url); return fetchText(url); } };
  const catalog = await kitsuCatalog({ type: 'series', category: 'top_rated', query: '', page: 2 }, options);
  assert.equal(catalog.items[0].id, 'kitsu:1'); assert.equal(catalog.items[0].metadata_provider, 'kitsu');
  assert.match(urls[0], /kitsu-anime-rating\/skip=20.json$/);
  urls.length = 0;
  await kitsuCatalog({ type: 'movie', category: 'popular', query: 'Name & other', page: 1 }, options);
  assert.match(urls[0], /search=Name\+%26\+other/);
});
test('adult, unknown-rating and invalid namespace entries are excluded', async () => {
  for (const attributes of [{ ageRating: 'R18', nsfw: true }, { ageRating: 'PG', nsfw: true }, { ageRating: null, nsfw: false }]) {
    const options = { fetchText: async (url) => url.startsWith('https://kitsu.io/') ? JSON.stringify({ data: [{ id: '1', attributes }] }) : fetchText(url) };
    assert.equal((await kitsuCatalog({ type: 'series', category: 'popular', page: 1 }, options)).items.length, 0);
    await assert.rejects(kitsuDetails('kitsu:1', 'series', options), { status: 404 });
  }
  await assert.rejects(kitsuDetails('https://private/', 'series', { fetchText }), { status: 400 });
  await assert.rejects(kitsuDetails('1', 'series', { fetchText }), { status: 400 });
});

test('search pagination slices ranked results locally and keeps rating lookups bounded', async () => {
  const metas = Array.from({ length: 25 }, (_, index) => ({ ...meta, id: `kitsu:${index + 1}` }));
  let safetyCalls = 0;
  const fetchText = async (url, options) => {
    if (url.startsWith('https://kitsu.io/')) {
      safetyCalls++; assert.equal(options.accept, 'application/vnd.api+json');
      const ids = new URL(url).searchParams.get('filter[id]').split(',');
      assert.equal(ids.length, 5);
      return JSON.stringify({ data: ids.map((id) => ({ id, attributes: { nsfw: false, ageRating: 'PG' } })) });
    }
    assert.match(url, /skip=0/);
    return JSON.stringify({ metas });
  };
  const catalog = await kitsuCatalog({ type: 'series', category: 'popular', query: 'Fixture', page: 2 }, { fetchText });
  assert.equal(catalog.total_pages, 2); assert.equal(catalog.items.length, 5);
  assert.equal(catalog.items[0].id, 'kitsu:21'); assert.equal(safetyCalls, 1);
});
test('episode number and video ID come from Kitsu, not enriched IMDb seasons', async () => {
  const detail = await kitsuDetails('kitsu:1', 'series', { fetchText });
  assert.deepEqual(detail.seasons, [{ number: 1, name: 'Episodes', episode_count: 2 }]);
  assert.equal(detail.episodes[0].number, 12); assert.equal(detail.episodes[0].video_id, 'kitsu:1:12');
  assert.equal(detail.episodes[0].mapped_season, 3); assert.equal(detail.episodes[0].mapped_episode, 1);
  assert.equal(detail.episodes[0].overview, 'Episode description');
});
test('source search verifies the exact episode and replaces client-supplied identity hints', async () => {
  const input = { type: 'series', section: 'anime', kitsu_id: 'kitsu:1', video_id: 'kitsu:1:12', season_int: 1, episode_int: 12, title: 'Wrong', stream_id: 'kitsu:2:1' };
  const canonical = await canonicalKitsuSearch(validateSearch(input), { fetchText });
  assert.equal(canonical.stream_id, 'kitsu:1:12'); assert.equal(canonical.title, 'Fixture Anime');
  assert.equal(canonical.absolute_episode, 12); assert.equal(canonical.mapped_season, 3);
  await assert.rejects(canonicalKitsuSearch({ ...input, video_id: 'kitsu:1:13' }, { fetchText }), { status: 404 });
  assert.throws(() => validateSearch({ ...input, video_id: 'kitsu:2:12' }), { status: 400 });
  assert.throws(() => validateSearch({ ...input, section: undefined, title: '', imdb_id: '' }), { status: 400 });
});
test('source add-ons receive the Kitsu episode ID; legacy scrapers do not run for Kitsu', async () => {
  const input = await canonicalKitsuSearch({ type: 'series', kitsu_id: 'kitsu:1', video_id: 'kitsu:1:12', season_int: 1, episode_int: 12 }, { fetchText });
  const urls = [];
  const response = await discoverSources({ scraper_url: 'https://legacy.example', stremio_addons: [{ id: 'a', name: 'Kitsu Sources', enabled: true, scopes: ['anime'], manifest_url: 'https://source.example/manifest.json' }] }, input, {
    fetchText: async (url) => {
      urls.push(url);
      return JSON.stringify(url.endsWith('manifest.json') ? { id: 'a', resources: ['stream'], types: ['series'], idPrefixes: ['kitsu:'] } :
        { streams: [{ infoHash: 'a'.repeat(40), title: 'Release - 12', behaviorHints: { filename: 'Release - 12.mkv' } }] });
    },
  });
  assert.equal(urls.length, 2); assert.equal(urls[1], 'https://source.example/stream/series/kitsu%3A1%3A12.json');
  assert.equal(response.sources[0].file_name, 'Release - 12.mkv');
});
test('Anime file selection supports exact filenames, mapped season numbers and absolute episodes, rejecting ambiguity', () => {
  const input = { section: 'anime', kitsu_id: 'kitsu:1', type: 'series', season_int: 1, episode_int: 12, absolute_episode: 12, mapped_season: 3, mapped_episode: 1 };
  const files = [{ path: 'Release - 11.mkv' }, { path: 'Release - 12.mkv' }];
  assert.equal(chooseVideo(files, input).path, 'Release - 12.mkv');
  assert.equal(chooseVideo([{ path: 'Series.S03E01.mkv' }, { path: 'Series.S01E12.mkv' }], input).path, 'Series.S03E01.mkv');
  assert.equal(chooseVideo([{ path: 'pack/named.mkv' }], { ...input, file_name: 'named.mkv' }).path, 'pack/named.mkv');
  assert.throws(() => chooseVideo([{ path: 'Episode.mkv' }], input), { status: 409 });
  assert.throws(() => chooseVideo([...files, { path: 'Other - 12.mp4' }], input), { status: 409 });
  assert.throws(() => chooseVideo(files, { ...input, file_name: 'Other.mkv' }), { status: 409 });
});
test('signed source capabilities bind Kitsu identity and file selection; caller hints cannot replace them', () => {
  const cap = createSourceCapabilities('test-key'), hash = 'a'.repeat(40);
  const metadata = { type: 'series', section: 'anime', kitsu_id: 'kitsu:1', stream_id: 'kitsu:1:12', season_int: 1, episode_int: 12, file_name: 'Release - 12.mkv' };
  const source_token = cap.issueSource(7, hash, metadata);
  const input = { type: 'series', hash, source_token, season_int: 1, episode_int: 12, file_name: 'Release - 11.mkv', stream_id: 'kitsu:2:1' };
  assert.equal(cap.requireDiscoveredSource(7, input).stream_id, metadata.stream_id);
  assert.equal(cap.requireDiscoveredSource(7, input).file_name, metadata.file_name);
  assert.throws(() => cap.requireDiscoveredSource(7, { ...input, episode_int: 11 }), { status: 409 });
});
