const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnimeFilters, searchAnime, animeFilterOptions } = require('./animeSearch.cjs');
const media = { id: 1, type: 'ANIME', isAdult: false, format: 'TV', title: { english: 'Fixture' } };
test('full search combines title and every filter with inclusive numeric bounds and stable sorting', async () => {
  const filters = { genres: ['Action', 'Adventure'], tags: ['Military'], format: 'TV', availability: 'released', year: 2013, season: 'SPRING', status: 'FINISHED', minDuration: 20, maxDuration: 30, minEpisodes: 12, maxEpisodes: 30, sort: 'score' };
  const data = await searchAnime({ type: 'series', query: 'Titan', page: 2, filters }, { request: async (query, v) => {
    assert.match(query, /isAdult: false/); assert.equal(v.search, 'Titan'); assert.deepEqual(v.genres, filters.genres); assert.deepEqual(v.tags, filters.tags);
    assert.equal(v.year, '2013%'); assert.equal(v.season, 'SPRING'); assert.equal(v.status, 'FINISHED'); assert.equal(v.statusNot, 'NOT_YET_RELEASED');
    assert.equal(v.minDuration, 19); assert.equal(v.maxDuration, 31); assert.equal(v.minEpisodes, 11); assert.equal(v.maxEpisodes, 31);
    assert.deepEqual(v.sort, ['SCORE_DESC', 'ID']); assert.deepEqual(v.formats, ['TV']); assert.equal(v.page, 2);
    return { Page: { media: [media, { ...media, id: 2, isAdult: true }], pageInfo: { hasNextPage: true } } };
  } });
  assert.equal(data.items.length, 1); assert.equal(data.total_pages, 3);
});
test('studio filtering intersects paged verified IDs with all other filters without unfiltered fallback', async () => {
  const calls = [];
  const data = await searchAnime({ type: 'series', page: 3, filters: { studio: 11, tags: ['Military'], sort: 'newest' } }, { request: async (query, v) => {
    calls.push(v);
    if (query.includes('StreamINStudioMedia')) return { Studio: { media: { nodes: [media, { ...media, id: 2, isAdult: true }], pageInfo: { hasNextPage: true } } } };
    assert.deepEqual(v.ids, [1]); assert.deepEqual(v.tags, ['Military']); assert.equal(v.page, 1);
    return { Page: { media: [media], pageInfo: { hasNextPage: false } } };
  } });
  assert.equal(calls[0].page, 3); assert.equal(calls[0].id, 11); assert.equal(data.page, 3); assert.equal(data.total_pages, 4);
});
test('filter validation rejects malformed, oversized, contradictory and out-of-range inputs before requests', async () => {
  for (const raw of ['{', 'null', '[]', JSON.stringify({ unknown: true }), JSON.stringify({ minDuration: 40, maxDuration: 20 }), JSON.stringify({ year: '2013' }), JSON.stringify({ minEpisodes: -1 }), JSON.stringify({ format: 'bad' }), JSON.stringify({ studio: 1.5 }), JSON.stringify({ tags: new Array(11).fill('A') }), JSON.stringify({ availability: 'upcoming', status: 'FINISHED' })]) assert.throws(() => parseAnimeFilters(raw), { status: 400 });
  await assert.rejects(searchAnime({ type: 'movie', filters: { format: 'TV' } }), { status: 400 });
  await assert.rejects(searchAnime({ type: 'series', page: 201, filters: {} }), { status: 400 });
});
test('options expose nonadult tags and animation studios only, with studio search and pagination', async () => {
  const result = await animeFilterOptions({ search: 'Map', page: 2 }, { request: async (_query, v) => {
    assert.equal(v.search, 'Map'); assert.equal(v.page, 2);
    return { GenreCollection: ['Action', 'Hentai'], MediaTagCollection: [{ name: 'Military', isAdult: false }, { name: 'Explicit', isAdult: true }], Page: { studios: [{ id: 1, name: 'MAPPA', isAnimationStudio: true }, { id: 2, name: 'Publisher', isAnimationStudio: false }], pageInfo: { hasNextPage: true } } };
  } });
  assert.deepEqual(result.genres, ['Action']); assert.deepEqual(result.tags, ['Military']); assert.equal(result.studios.length, 1); assert.equal(result.has_next_page, true);
});
test('default zero minima do not filter unknown episode counts or durations', async () => {
  await searchAnime({ type: 'movie', filters: { minDuration: 0, minEpisodes: 0 } }, { request: async (_query, v) => {
    assert.equal(v.minDuration, undefined); assert.equal(v.minEpisodes, undefined);
    return { Page: { media: [], pageInfo: {} } };
  } });
});
