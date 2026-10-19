const { readText } = require('./scraperHttp.cjs');
const { kitsuDetails } = require('./kitsuCatalog.cjs');

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
const FORMATS = ['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'];
const FIELDS = `id idMal type format status isAdult title { english romaji native }
  description(asHtml: false) coverImage { large extraLarge } bannerImage
  startDate { year month day } averageScore duration episodes`;
const CATALOG = `query StreamINAnimeCatalog($page: Int!, $search: String, $formats: [MediaFormat], $sort: [MediaSort], $status: MediaStatus, $genre: String, $before: FuzzyDateInt) {
  Page(page: $page, perPage: 20) { pageInfo { currentPage hasNextPage }
    media(type: ANIME, isAdult: false, search: $search, format_in: $formats, sort: $sort, status: $status, genre: $genre, startDate_lesser: $before) { ${FIELDS} }
  }
}`;
const LATEST = `query StreamINAnimeEpisodes($page: Int!, $now: Int!, $since: Int!) {
  Page(page: $page, perPage: 20) { pageInfo { currentPage hasNextPage }
    airingSchedules(airingAt_lesser: $now, airingAt_greater: $since, sort: TIME_DESC) {
      episode airingAt media { ${FIELDS} }
    }
  }
}`;
const DETAIL = `query StreamINAnimeDetails($id: Int!) { Media(id: $id, type: ANIME, isAdult: false) { ${FIELDS} } }`;

// Public metadata only. Bounded short-lived caching is not a local catalog mirror.
function createAniListClient({ fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  let windowStart = 0, count = 0, retryAt = 0;
  return async (query, variables) => {
    const key = JSON.stringify([query, variables]);
    const time = now(), hit = cache.get(key);
    if (hit?.expires > time) return hit.data;
    if (pending.has(key)) return pending.get(key);
    if (time - windowStart >= 60000) { windowStart = time; count = 0; }
    if (retryAt > time || count >= 25 || pending.size >= 4) throw fail('Anime catalog is busy. Try again shortly.', 503);
    count++;
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetcher('https://graphql.anilist.co', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        if (response.status === 429) {
          retryAt = now() + Math.min(300, Math.max(1, Number(response.headers.get('retry-after')) || 60)) * 1000;
          throw fail('Anime catalog is busy. Try again shortly.', 503);
        }
        if (!response.ok) throw fail('AniList catalog temporarily unavailable.');
        const data = await response.json();
        if (data.errors?.length || !data.data) throw fail('AniList catalog temporarily unavailable.');
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { data: data.data, expires: now() + 300000 });
        return data.data;
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
const request = createAniListClient();
function safe(media) {
  return media?.type === 'ANIME' && media.isAdult === false && Number.isSafeInteger(media.id) && media.id > 0 &&
    (media.format === 'MOVIE' || FORMATS.includes(media.format));
}
function image(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function item(media) {
  return { id: `anilist:${media.id}`, anilist_id: media.id, type: media.format === 'MOVIE' ? 'movie' : 'series',
    section: 'anime', metadata_provider: 'anilist', title: String(media.title?.english || media.title?.romaji || media.title?.native || '').slice(0, 200),
    original_title: String(media.title?.romaji || media.title?.english || '').slice(0, 200),
    year: String(media.startDate?.year || ''), overview: String(media.description || '').replace(/<[^>]*>/g, '').slice(0, 10000),
    poster: image(media.coverImage?.extraLarge || media.coverImage?.large), backdrop: image(media.bannerImage),
    rating: (Number(media.averageScore) || 0) / 10, runtime: Math.min(600, Math.max(0, Number(media.duration) || 0)),
    status: media.status };
}
async function anilistCatalog({ type, category = 'popular', query = '', page = 1, genre = '' }, options = {}) {
  const run = options.request || request;
  if (!['movie', 'series'].includes(type) || !Number.isInteger(page) || page < 1 || page > 500 || (genre && !GENRES.includes(genre))) throw fail('Invalid Anime catalog filter', 400);
  const sorts = { popular: 'POPULARITY_DESC', top_rated: 'SCORE_DESC', trending: 'TRENDING_DESC', airing: 'POPULARITY_DESC', new_releases: 'START_DATE_DESC', completed: 'POPULARITY_DESC', upcoming: 'POPULARITY_DESC' };
  if (!sorts[category] && category !== 'latest_episodes') throw fail('Invalid Anime category', 400);
  const now = options.now ?? Date.now();
  let response, records;
  if (category === 'latest_episodes' && !query && !genre) {
    const seconds = Math.floor(now / 1000);
    response = await run(LATEST, { page, now: Math.floor(seconds / 300) * 300, since: Math.floor(seconds / 300) * 300 - 7 * 86400 });
    if (!Array.isArray(response.Page?.airingSchedules)) throw fail('Invalid AniList episode response');
    records = response.Page.airingSchedules.filter(entry => Number.isInteger(entry.episode) && entry.episode > 0 && entry.airingAt <= seconds)
      .map(entry => ({ ...entry.media, latest_episode: entry.episode, aired_at: entry.airingAt }));
  } else {
    const date = new Date(now + 86400000);
    const before = Number(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`);
    const status = { airing: 'RELEASING', completed: 'FINISHED', upcoming: 'NOT_YET_RELEASED' }[category];
    response = await run(CATALOG, { page, formats: type === 'movie' ? ['MOVIE'] : FORMATS,
      ...(query ? { search: query, sort: ['SEARCH_MATCH'] } : { sort: [sorts[category] || 'POPULARITY_DESC'],
        ...(status ? { status } : {}), ...(genre ? { genre } : {}), ...(category === 'new_releases' ? { before } : {}) }) });
    if (!Array.isArray(response.Page?.media)) throw fail('Invalid AniList catalog response');
    records = response.Page.media;
  }
  const seen = new Set();
  const items = records.filter(safe).map(media => ({ ...item(media), ...(media.latest_episode ? { latest_episode: media.latest_episode, aired_at: media.aired_at } : {}) }))
    .filter(value => value.type === type && value.title && !seen.has(value.id) && seen.add(value.id));
  return { page, total_pages: response.Page.pageInfo?.hasNextPage ? Math.min(page + 1, 500) : page, items, metadata_provider: 'anilist',
    ...(category === 'upcoming' && !query ? { notice: 'Upcoming titles may not have released episodes or playback sources yet.' } : {}) };
}

async function mappedKitsuId(media, fetchText) {
  if (!Number.isSafeInteger(media.idMal) || media.idMal <= 0) return null;
  const url = new URL('https://kitsu.io/api/edge/mappings');
  url.search = new URLSearchParams({ 'filter[externalSite]': 'myanimelist/anime', 'filter[externalId]': String(media.idMal), 'page[limit]': '2',
    include: 'item', 'fields[anime]': 'subtype' }).toString();
  const response = JSON.parse(await fetchText(url.href, { accept: 'application/vnd.api+json' }));
  if (!Array.isArray(response.data)) throw fail('Anime playback mapping temporarily unavailable.');
  if (Number(response.meta?.count) > 2) return null;
  const ids = [...new Set(response.data.filter(entry => entry.type === 'mappings' &&
    entry.attributes?.externalSite === 'myanimelist/anime' && String(entry.attributes?.externalId) === String(media.idMal) &&
    entry.relationships?.item?.data?.type === 'anime' && /^[1-9]\d{0,8}$/.test(String(entry.relationships.item.data.id)))
    .map(entry => `kitsu:${entry.relationships.item.data.id}`))];
  return ids.length === 1 ? ids[0] : null;
}
const mappings = new Map();
async function anilistDetails(id, type, options = {}) {
  if (!/^anilist:[1-9]\d{0,8}$/.test(String(id)) || !['movie', 'series'].includes(type)) throw fail('Invalid AniList identifier', 400);
  const data = await (options.request || request)(DETAIL, { id: Number(id.split(':')[1]) });
  if (!safe(data.Media)) throw fail('Anime title unavailable', 404);
  const detail = item(data.Media);
  if (detail.type !== type) throw fail('Anime title unavailable', 404);
  const unavailable = notice => ({ ...detail, episodes: [], seasons: [], playback_available: false, notice });
  const fetchText = options.fetchText || readText;
  let kitsu;
  try {
    const cached = fetchText === readText ? mappings.get(id) : null;
    kitsu = cached?.expires > Date.now() ? cached.id : await mappedKitsuId(data.Media, fetchText);
    if (kitsu && fetchText === readText) {
      if (mappings.size >= 100) mappings.delete(mappings.keys().next().value);
      mappings.set(id, { id: kitsu, expires: Date.now() + 300000 });
    }
    if (!kitsu) return unavailable('This title has no verified playback mapping for the configured Anime source add-ons yet.');
    const episodes = await (options.kitsuDetails || kitsuDetails)(kitsu, type);
    // Keep the established playback/history identity; never infer episode numbers from titles.
    return { ...episodes, ...detail, id: kitsu, kitsu_id: kitsu, episodes: episodes.episodes, seasons: episodes.seasons, playback_available: true };
  } catch {
    return unavailable('Anime playback mapping is temporarily unavailable. Try again shortly.');
  }
}
module.exports = { anilistCatalog, anilistDetails, createAniListClient };
