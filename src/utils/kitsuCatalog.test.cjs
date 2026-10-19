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
  assert.equal(new URL(urls[0]).searchParams.get('filter[text]'), 'Name & other');
  assert.equal(new URL(urls[0]).searchParams.get('filter[subtype]'), 'movie');
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

const edgeMeta = (id, overrides = {}) => ({ id: String(id), type: 'anime', attributes: {
  canonicalTitle: 'Fixture Romanized', titles: { en: 'Fixture English' }, nsfw: false, ageRating: 'PG',
  subtype: 'TV', averageRating: '80', startDate: '2026-01-01', ...overrides,
} });

test('search uses paginated full-catalog search instead of truncating addon matches', async () => {
  let calls = 0;
  const fetchText = async (url, options) => {
    calls++; assert.equal(options.accept, 'application/vnd.api+json');
    const params = new URL(url).searchParams;
    assert.equal(params.get('page[offset]'), '200');
    assert.equal(params.get('filter[text]'), 'Fixture');
    assert.equal(params.get('filter[subtype]'), 'TV,OVA,ONA,special,music');
    return JSON.stringify({ data: [edgeMeta(201)], meta: { count: 241 } });
  };
  const catalog = await kitsuCatalog({ type: 'series', category: 'popular', query: 'Fixture', page: 11 }, { fetchText });
  assert.equal(catalog.total_pages, 13); assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].id, 'kitsu:201'); assert.equal(calls, 1);
  assert.equal(catalog.items[0].title, 'Fixture English');
  assert.equal(catalog.items[0].original_title, 'Fixture Romanized');
  assert.equal(catalog.items[0].rating, 8);
});

test('new Anime categories pass verified status, sorting and genre filters', async () => {
  for (const [category, status, sort] of [['airing', 'current', '-userCount'], ['new_releases', 'current', '-startDate'], ['completed', 'finished', '-userCount'], ['upcoming', 'upcoming', 'startDate']]) {
    const result = await kitsuCatalog({ type: 'series', category, genre: 'Fantasy', page: 2 }, {
      fetchText: async url => {
        const p = new URL(url).searchParams;
        assert.equal(p.get('filter[status]'), status); assert.equal(p.get('sort'), sort);
        assert.equal(p.get('filter[genres]'), 'Fantasy'); assert.equal(p.get('page[offset]'), '20');
        return JSON.stringify({ data: [edgeMeta(1)], meta: { count: 50 } });
      },
    });
    assert.equal(result.items[0].id, 'kitsu:1'); assert.equal(result.total_pages, 3);
    if (category === 'upcoming') assert.match(result.notice, /not have released/);
  }
});

test('direct catalog search retains rating safety and type boundaries', async () => {
  const result = await kitsuCatalog({ type: 'series', query: 'Fixture', page: 1 }, { fetchText: async () => JSON.stringify({ data: [
    edgeMeta(1), edgeMeta(2, { nsfw: true }), edgeMeta(3, { ageRating: 'R18' }),
    edgeMeta(4, { ageRating: null }), edgeMeta(5, { subtype: 'movie' }), { ...edgeMeta(6), id: 'bad-id' },
  ], meta: { count: 6 } }) });
  assert.deepEqual(result.items.map(value => value.id), ['kitsu:1']);
  await assert.rejects(kitsuCatalog({ type: 'series', page: 1, genre: 'Hentai' }), { status: 400 });
});

test('trending is bounded to the upstream feed and retains Kitsu IDs', async () => {
  const result = await kitsuCatalog({ type: 'series', category: 'trending', page: 1 }, { fetchText: async url => {
    if (url.startsWith('https://kitsu.io/')) return JSON.stringify(safe);
    assert.match(url, /kitsu-anime-trending/);
    return JSON.stringify({ metas: [meta] });
  } });
  assert.equal(result.total_pages, 1); assert.equal(result.items[0].id, 'kitsu:1');
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
