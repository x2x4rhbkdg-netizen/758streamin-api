const test = require('node:test');
const assert = require('node:assert/strict');
const { jikanCatalog, jikanDetails, createJikanClient } = require('./jikanCatalog.cjs');
const media = { mal_id: 16498, type: 'TV', rating: 'R - 17+ (violence & profanity)', title: 'Shingeki no Kyojin', title_english: 'Attack on Titan',
  episodes: 25, duration: '24 min per ep', genres: [{ mal_id: 1, name: 'Action' }], images: { jpg: { large_image_url: 'https://example.com/poster.jpg' } } };

test('Jikan catalog normalizes metadata, filters unsafe and mismatched titles and preserves pagination', async () => {
  const result = await jikanCatalog({ type: 'series', category: 'top_rated', page: 2, genre: 'Action' }, { request: async (path, params) => {
    assert.equal(path, 'anime'); assert.equal(params.sfw, 'true'); assert.equal(params.genres_exclude, '12,49');
    assert.equal(params.order_by, 'score'); assert.equal(params.genres, '1'); assert.equal(params.page, '2');
    return { data: [media, media, { ...media, mal_id: 2, rating: 'Rx - Hentai' }, { ...media, mal_id: 3, rating: null },
      { ...media, mal_id: 4, explicit_genres: [{ mal_id: 49 }] }, { ...media, mal_id: 5, type: 'Movie' }], pagination: { has_next_page: true } };
  } });
  assert.deepEqual(result.items.map(value => value.id), ['mal:16498']);
  assert.equal(result.items[0].metadata_provider, 'jikan'); assert.equal(result.items[0].runtime, 24); assert.equal(result.total_pages, 3);
  await assert.rejects(jikanCatalog({ type: 'series', genre: 'Hentai' }), { status: 400 });
});

test('Jikan search and status categories use documented filters and disclose approximate feeds', async () => {
  for (const category of ['airing', 'latest_episodes', 'new_releases', 'completed', 'upcoming', 'trending']) {
    const result = await jikanCatalog({ type: 'movie', category, page: 1 }, { request: async (_, params) => {
      assert.equal(params.type, 'movie');
      assert.equal(params.status, { airing: 'airing', latest_episodes: 'airing', new_releases: 'airing', completed: 'complete', upcoming: 'upcoming' }[category]);
      return { data: [], pagination: {} };
    } });
    if (category === 'latest_episodes') assert.match(result.notice, /rather than a latest-episode/);
    if (category === 'trending') assert.match(result.notice, /popularity/);
  }
  await jikanCatalog({ type: 'series', query: 'A & B', genre: 'Fantasy', page: 3 }, { request: async (_, params) => {
    assert.equal(params.q, 'A & B'); assert.equal(params.genres, '10'); assert.equal(params.order_by, undefined);
    return { data: [] };
  } });
});

test('Jikan details map only exact MAL identities to established Kitsu episodes and history', async () => {
  const result = await jikanDetails('mal:16498', 'series', { request: async path => {
    assert.equal(path, 'anime/16498/full'); return { data: media };
  }, fetchText: async url => {
    assert.equal(new URL(url).searchParams.get('filter[externalId]'), '16498');
    return JSON.stringify({ data: [{ type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '16498' },
      relationships: { item: { data: { type: 'anime', id: '7442' } } } }] });
  }, kitsuDetails: async (id, type) => {
    assert.equal(id, 'kitsu:7442'); assert.equal(type, 'series');
    return { episodes: [{ number: 1, video_id: 'kitsu:7442:1' }], seasons: [{ number: 1 }] };
  } });
  assert.equal(result.id, 'kitsu:7442'); assert.equal(result.mal_id, 16498); assert.equal(result.metadata_provider, 'jikan');
  assert.equal(result.episodes[0].video_id, 'kitsu:7442:1'); assert.equal(result.playback_available, true);
  const unmapped = await jikanDetails('mal:16498', 'series', { request: async () => ({ data: media }), fetchText: async () => JSON.stringify({ data: [] }) });
  assert.equal(unmapped.id, 'mal:16498'); assert.equal(unmapped.playback_available, false);
  await assert.rejects(jikanDetails('mal:16498', 'series', { request: async () => ({ data: { ...media, mal_id: 99 } }) }), { status: 404 });
});

test('Jikan client coalesces requests, caches, spaces unique requests and backs off rate limits', async () => {
  let clock = 1000000, calls = 0;
  const times = [];
  const client = createJikanClient({ now: () => clock, sleep: async ms => { clock += ms; }, fetcher: async url => {
    calls++; times.push(clock); assert.equal(new URL(url).origin, 'https://api.jikan.moe');
    return { ok: true, json: async () => ({ data: [] }) };
  } });
  await Promise.all([client('anime', { page: '1' }), client('anime', { page: '1' }), client('anime', { page: '2' })]);
  assert.equal(calls, 2); assert.equal(times[1] - times[0], 1000);
  await client('anime', { page: '1' }); assert.equal(calls, 2);
  let limitedCalls = 0;
  const limited = createJikanClient({ now: () => clock, sleep: async () => {}, fetcher: async () => {
    limitedCalls++; return { status: 429, headers: { get: () => '60' } };
  } });
  await assert.rejects(limited('anime'), { status: 503 });
  await assert.rejects(limited('anime', { page: '2' }), { status: 503 }); assert.equal(limitedCalls, 1);
  await assert.rejects(client('https://private'), { status: 400 });
});
