const test = require('node:test');
const assert = require('node:assert/strict');
const { anilistCatalog, anilistDetails, createAniListClient } = require('./anilistCatalog.cjs');
const media = { id: 16498, idMal: 16498, type: 'ANIME', format: 'TV', status: 'FINISHED', isAdult: false,
  title: { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin' }, description: 'A description',
  coverImage: { large: 'https://example.com/poster.jpg' }, averageScore: 84, startDate: { year: 2013 }, duration: 24 };
const mapping = { data: [{ type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '16498' },
  relationships: { item: { data: { type: 'anime', id: '7442' } } } }] };

test('catalog queries use AniList categories, safe formats, search, genre and pagination', async () => {
  for (const [category, sort, status] of [['popular', 'POPULARITY_DESC'], ['top_rated', 'SCORE_DESC'], ['trending', 'TRENDING_DESC'], ['airing', 'POPULARITY_DESC', 'RELEASING'], ['completed', 'POPULARITY_DESC', 'FINISHED'], ['upcoming', 'POPULARITY_DESC', 'NOT_YET_RELEASED'], ['new_releases', 'START_DATE_DESC']]) {
    const result = await anilistCatalog({ type: 'series', category, genre: 'Fantasy', page: 2 }, { request: async (query, variables) => {
      assert.match(query, /isAdult: false/); assert.deepEqual(variables.sort, [sort]);
      assert.equal(variables.status, status); assert.equal(variables.genre, 'Fantasy');
      assert.equal(variables.page, 2); assert.ok(variables.formats.includes('OVA')); assert.ok(!variables.formats.includes('MOVIE'));
      if (category === 'new_releases') assert.equal(typeof variables.before, 'number');
      return { Page: { media: [media], pageInfo: { hasNextPage: true } } };
    } });
    assert.equal(result.items[0].id, 'anilist:16498'); assert.equal(result.items[0].rating, 8.4);
    assert.equal(result.items[0].metadata_provider, 'anilist'); assert.equal(result.total_pages, 3);
  }
  await anilistCatalog({ type: 'movie', category: 'airing', query: 'A & B', page: 1 }, { request: async (_query, v) => {
    assert.deepEqual(v.formats, ['MOVIE']); assert.equal(v.search, 'A & B'); assert.equal(v.status, undefined);
    assert.deepEqual(v.sort, ['SEARCH_MATCH']); return { Page: { media: [], pageInfo: {} } };
  } });
});

test('catalog drops adult, unknown classification, invalid IDs and mismatched formats', async () => {
  const result = await anilistCatalog({ type: 'series', page: 1 }, { request: async () => ({ Page: { media: [media, media,
    { ...media, id: 2, isAdult: true }, { ...media, id: 3, isAdult: null }, { ...media, id: 4, format: 'MOVIE' }, { ...media, id: 'bad' }], pageInfo: {} } }) });
  assert.deepEqual(result.items.map(value => value.id), ['anilist:16498']);
  await assert.rejects(anilistCatalog({ type: 'series', page: 1, genre: 'Hentai' }), { status: 400 });
});

test('Latest Episodes uses aired schedules, preserves episode labels and deduplicates titles', async () => {
  const seconds = 1792368000;
  const result = await anilistCatalog({ type: 'series', category: 'latest_episodes', page: 1 }, {
    now: seconds * 1000, request: async (query, v) => {
      assert.match(query, /airingSchedules/); assert.equal(v.now, seconds); assert.equal(v.since, seconds - 7 * 86400);
      return { Page: { airingSchedules: [{ episode: 5, airingAt: seconds - 100, media }, { episode: 4, airingAt: seconds - 200, media },
        { episode: 6, airingAt: seconds + 100, media: { ...media, id: 5 } }], pageInfo: { hasNextPage: true } } };
    },
  });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].latest_episode, 5); assert.equal(result.total_pages, 2);
});

test('details map exact MAL identity to Kitsu playback IDs while preserving AniList metadata', async () => {
  const result = await anilistDetails('anilist:16498', 'series', {
    request: async (_query, v) => { assert.equal(v.id, 16498); return { Media: media }; },
    fetchText: async url => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('filter[externalSite]'), 'myanimelist/anime'); assert.equal(params.get('filter[externalId]'), '16498');
      assert.equal(params.get('include'), 'item');
      return JSON.stringify(mapping);
    },
    kitsuDetails: async (id, type) => {
      assert.equal(id, 'kitsu:7442'); assert.equal(type, 'series');
      return { id, type, episodes: [{ number: 12, video_id: 'kitsu:7442:12', released: '2020-01-01' }], seasons: [{ number: 1 }] };
    },
  });
  assert.equal(result.id, 'kitsu:7442'); assert.equal(result.anilist_id, 16498); assert.equal(result.metadata_provider, 'anilist');
  assert.equal(result.title, 'Attack on Titan'); assert.equal(result.episodes[0].video_id, 'kitsu:7442:12');
  assert.equal(result.playback_available, true);
});

test('missing, ambiguous or failed mappings remain browsable but never guess a playback identity', async () => {
  for (const mappings of [{ data: [] }, { data: [...mapping.data, { ...mapping.data[0], relationships: { item: { data: { type: 'anime', id: '999' } } } }] },
    { data: [{ ...mapping.data[0], attributes: { externalSite: 'myanimelist/anime', externalId: 'different' } }] }]) {
    const result = await anilistDetails('anilist:16498', 'series', { request: async () => ({ Media: media }), fetchText: async () => JSON.stringify(mappings),
      kitsuDetails: async () => { throw new Error('must not call'); } });
    assert.equal(result.id, 'anilist:16498'); assert.equal(result.playback_available, false); assert.deepEqual(result.episodes, []);
  }
  const unavailable = await anilistDetails('anilist:16498', 'series', { request: async () => ({ Media: media }), fetchText: async () => { throw new Error('private URL'); } });
  assert.match(unavailable.notice, /temporarily unavailable/); assert.ok(!unavailable.notice.includes('private'));
  await assert.rejects(anilistDetails('anilist:16498', 'series', { request: async () => ({ Media: { ...media, isAdult: true } }) }), { status: 404 });
  await assert.rejects(anilistDetails('https://private', 'series'), { status: 400 });
});

test('public metadata client coalesces requests, caches briefly and honors rate-limit backoff', async () => {
  let clock = 1000000, calls = 0, finish;
  const client = createAniListClient({ now: () => clock, fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://graphql.anilist.co'); assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, undefined);
    return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ data: { fixture: calls } }) }); });
  } });
  const first = client('query', { page: 1 }), second = client('query', { page: 1 });
  assert.equal(calls, 1); finish(); await first; await second;
  await client('query', { page: 1 }); assert.equal(calls, 1);
  clock += 300001; const again = client('query', { page: 1 }); finish(); await again; assert.equal(calls, 2);
  let rejectedCalls = 0;
  const limited = createAniListClient({ now: () => clock, fetcher: async () => {
    rejectedCalls++; return { status: 429, headers: { get: () => '30' } };
  } });
  await assert.rejects(limited('query', {}), { status: 503 });
  await assert.rejects(limited('query', {}), { status: 503 }); assert.equal(rejectedCalls, 1);
});
