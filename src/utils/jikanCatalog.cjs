const { readText } = require('./scraperHttp.cjs');
const { mappedKitsuId } = require('./anilistCatalog.cjs');
const { kitsuDetails } = require('./kitsuCatalog.cjs');

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const GENRES = { Action: 1, Adventure: 2, Comedy: 4, Drama: 8, Fantasy: 10, Horror: 14, Mystery: 7,
  Romance: 22, 'Sci-Fi': 24, 'Slice of Life': 36, Sports: 30, Supernatural: 37, Thriller: 41 };
const CATEGORIES = ['popular', 'top_rated', 'trending', 'airing', 'latest_episodes', 'new_releases', 'completed', 'upcoming'];
const FORMATS = ['TV', 'OVA', 'ONA', 'Special', 'TV Special', 'Music', 'Movie'];
const RATINGS = ['G - All Ages', 'PG - Children', 'PG-13 - Teens 13 or older', 'R - 17+ (violence & profanity)'];

// One request per second per process, coalesced and cached; no catalog mirroring.
function createJikanClient({ fetcher = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map(), pending = new Map();
  let nextAt = 0, retryAt = 0, tail = Promise.resolve();
  return async (path, params = {}) => {
    if (!/^anime(?:\/[1-9]\d{0,8}\/full)?$/.test(path)) throw fail('Invalid Jikan endpoint', 400);
    const url = new URL(`https://api.jikan.moe/v4/${path}`);
    url.search = new URLSearchParams(params).toString();
    const key = url.href, hit = cache.get(key);
    if (hit?.expires > now()) return hit.data;
    if (pending.has(key)) return pending.get(key);
    if (retryAt > now() || pending.size >= 4) throw fail('Jikan catalog is busy. Try again shortly.', 503);
    const task = tail.then(async () => {
      if (retryAt > now()) throw fail('Jikan catalog is busy. Try again shortly.', 503);
      await sleep(Math.max(0, nextAt - now()));
      nextAt = now() + 1000;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetcher(url.href, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (response.status === 429) {
          retryAt = now() + Math.min(300, Math.max(1, Number(response.headers?.get('retry-after')) || 60)) * 1000;
          throw fail('Jikan catalog is busy. Try again shortly.', 503);
        }
        if (response.status === 404) throw fail('Anime title unavailable', 404);
        if (!response.ok) { retryAt = now() + 30000; throw fail('Jikan catalog temporarily unavailable.', 503); }
        const data = await response.json();
        if (!data || !Object.hasOwn(data, 'data')) throw fail('Invalid Jikan response');
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { data, expires: now() + 300000 });
        return data;
      } catch (error) {
        if (error.status) throw error;
        throw fail('Jikan catalog temporarily unavailable.', 503);
      } finally { clearTimeout(timer); }
    });
    tail = task.catch(() => {});
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
const request = createJikanClient();
function safe(media) {
  return Number.isSafeInteger(media?.mal_id) && media.mal_id > 0 && FORMATS.includes(media.type) && RATINGS.includes(media.rating) &&
    ![...(media.genres || []), ...(media.explicit_genres || [])].some(genre => [12, 49].includes(genre.mal_id));
}
function image(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function item(media) {
  const duration = String(media.duration || '');
  const runtime = (Number(duration.match(/(\d+)\s*hr/)?.[1]) || 0) * 60 + (Number(duration.match(/(\d+)\s*min/)?.[1]) || 0);
  return { id: `mal:${media.mal_id}`, mal_id: media.mal_id, type: media.type === 'Movie' ? 'movie' : 'series', section: 'anime', metadata_provider: 'jikan',
    title: String(media.title_english || media.title || media.title_japanese || '').slice(0, 200),
    original_title: String(media.title || '').slice(0, 200), native_title: String(media.title_japanese || '').slice(0, 200),
    year: String(media.year || media.aired?.prop?.from?.year || ''), overview: String(media.synopsis || '').slice(0, 10000),
    poster: image(media.images?.jpg?.large_image_url || media.images?.jpg?.image_url), backdrop: null,
    format: media.type, status: media.status, rating: Number(media.score) || 0,
    runtime: Math.min(600, runtime), episode_count: Number.isInteger(media.episodes) && media.episodes > 0 ? media.episodes : null,
    genres: (media.genres || []).map(genre => genre.name).filter(value => typeof value === 'string'),
    popularity: Number(media.members) || null, favourites: Number(media.favorites) || null,
    anime_season: [media.season, media.year].filter(Boolean).join(' ') };
}
async function jikanCatalog({ type, category = 'popular', query = '', page = 1, genre = '' }, options = {}) {
  if (!['movie', 'series'].includes(type) || !CATEGORIES.includes(category) || !Number.isInteger(page) || page < 1 || page > 500 ||
      typeof query !== 'string' || query.length > 200 || (genre && !Object.hasOwn(GENRES, genre))) throw fail('Invalid Anime catalog filter', 400);
  const params = { page: String(page), limit: '20', sfw: 'true', genres_exclude: '12,49' };
  if (type === 'movie') params.type = 'movie';
  if (query) params.q = query;
  else {
    params.order_by = category === 'top_rated' ? 'score' : ['new_releases', 'upcoming'].includes(category) ? 'start_date' : 'members';
    params.sort = category === 'upcoming' ? 'asc' : 'desc';
    const status = { airing: 'airing', latest_episodes: 'airing', new_releases: 'airing', completed: 'complete', upcoming: 'upcoming' }[category];
    if (status) params.status = status;
  }
  if (genre) params.genres = String(GENRES[genre]);
  const data = await (options.request || request)('anime', params);
  if (!Array.isArray(data.data)) throw fail('Invalid Jikan catalog response');
  const seen = new Set();
  const items = data.data.filter(safe).map(item).filter(value => value.type === type && value.title && !seen.has(value.id) && seen.add(value.id));
  const notice = category === 'latest_episodes' ? 'Jikan shows currently airing titles rather than a latest-episode feed.'
    : category === 'trending' ? 'Jikan ranks this feed by popularity.'
      : category === 'upcoming' ? 'Upcoming titles may not have released episodes or playback sources yet.' : '';
  return { items, page, total_pages: data.pagination?.has_next_page ? Math.min(500, page + 1) : page, metadata_provider: 'jikan', ...(notice ? { notice } : {}) };
}
async function jikanDetails(id, type, options = {}) {
  if (!/^mal:[1-9]\d{0,8}$/.test(String(id)) || !['movie', 'series'].includes(type)) throw fail('Invalid Jikan identifier', 400);
  const { data } = await (options.request || request)(`anime/${id.split(':')[1]}/full`);
  if (!safe(data) || data.mal_id !== Number(id.split(':')[1])) throw fail('Anime title unavailable', 404);
  const detail = item(data);
  if (detail.type !== type) throw fail('Anime title unavailable', 404);
  const unavailable = notice => ({ ...detail, seasons: [], episodes: [], playback_available: false, notice });
  try {
    const kitsu = await mappedKitsuId({ idMal: data.mal_id }, options.fetchText || readText);
    if (!kitsu) return unavailable('This title has no verified playback mapping yet.');
    const playback = await (options.kitsuDetails || kitsuDetails)(kitsu, type);
    return { ...playback, ...detail, id: kitsu, kitsu_id: kitsu, seasons: playback.seasons, episodes: playback.episodes, playback_available: true };
  } catch { return unavailable('Anime playback mapping is temporarily unavailable. Try again shortly.'); }
}
module.exports = { createJikanClient, jikanCatalog, jikanDetails };
