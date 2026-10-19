const { readText } = require('./scraperHttp.cjs');
const BASE = 'https://anime-kitsu.strem.fun/';
const cache = new Map();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const kitsuId = (id) => /^kitsu:[1-9]\d{0,8}$/.test(String(id));
const minutes = (value) => Math.min(600, Math.max(0, Number.parseInt(String(value), 10) || 0));
function image(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
async function json(url, fetchText) {
  const hit = cache.get(url);
  if (fetchText === readText && hit?.expires > Date.now()) return hit.data;
  const data = JSON.parse(await fetchText(url, new URL(url).hostname === 'kitsu.io' ? { accept: 'application/vnd.api+json' } : {}));
  if (fetchText === readText) {
    if (cache.size >= 150) cache.delete(cache.keys().next().value);
    cache.set(url, { data, expires: Date.now() + 300000 });
  }
  return data;
}
async function safeIds(ids, fetchText) {
  if (!ids.length) return new Set();
  const url = new URL('https://kitsu.io/api/edge/anime');
  url.search = new URLSearchParams({ 'filter[id]': ids.map((id) => id.split(':')[1]).join(','), 'fields[anime]': 'ageRating,nsfw,subtype', 'page[limit]': '20' }).toString();
  const response = await json(url.href, fetchText);
  if (!Array.isArray(response.data)) throw new Error('Invalid Kitsu safety response');
  return new Set(response.data.filter((entry) => entry.attributes?.nsfw === false && ['G', 'PG', 'R'].includes(entry.attributes?.ageRating)).map((entry) => `kitsu:${entry.id}`));
}
function item(meta) {
  return { id: meta.id, type: meta.type, section: 'anime', metadata_provider: 'kitsu',
    title: String(meta.name || '').slice(0, 200), original_title: String(meta.name || '').slice(0, 200),
    year: String(meta.releaseInfo || '').slice(0, 4), overview: String(meta.description || '').slice(0, 10000),
    poster: image(meta.poster), backdrop: image(meta.background), rating: Number(meta.imdbRating) || 0, runtime: minutes(meta.runtime) };
}
function acceptable(meta) {
  return meta && kitsuId(meta.id) && ['movie', 'series'].includes(meta.type) && meta.name &&
    !meta.genres?.some((g) => /^(hentai|erotica)$/i.test(g));
}
const ANIME_GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
function edgeItem(entry) {
  const a = entry.attributes || {};
  const title = a.titles?.en || a.titles?.en_us || a.canonicalTitle || a.titles?.en_jp;
  const result = item({ id: `kitsu:${entry.id}`, type: a.subtype === 'movie' ? 'movie' : 'series', name: title,
    releaseInfo: a.startDate, description: a.synopsis || a.description,
    poster: a.posterImage?.large || a.posterImage?.original, background: a.coverImage?.large || a.coverImage?.original,
    imdbRating: Number(a.averageRating) / 10, runtime: a.episodeLength });
  return { ...result, original_title: String(a.canonicalTitle || title || '').slice(0, 200), status: a.status };
}
async function edgeCatalog({ type, category, query, page, genre }, fetchText) {
  const url = new URL('https://kitsu.io/api/edge/anime');
  url.searchParams.set('page[limit]', '20');
  url.searchParams.set('page[offset]', String((page - 1) * 20));
  url.searchParams.set('filter[subtype]', type === 'movie' ? 'movie' : 'TV,OVA,ONA,special,music');
  if (query) url.searchParams.set('filter[text]', query);
  else {
    const status = { airing: 'current', new_releases: 'current', completed: 'finished', upcoming: 'upcoming' }[category];
    if (status) url.searchParams.set('filter[status]', status);
    url.searchParams.set('sort', category === 'upcoming' ? 'startDate' : category === 'new_releases' ? '-startDate' : category === 'top_rated' ? '-averageRating' : '-userCount');
    if (genre) url.searchParams.set('filter[genres]', genre);
  }
  const data = await json(url.href, fetchText);
  if (!Array.isArray(data.data)) throw new Error('Invalid Anime catalog');
  const items = data.data.filter(entry => /^[1-9]\d{0,8}$/.test(String(entry.id)) && entry.type === 'anime' &&
    entry.attributes?.nsfw === false && ['G', 'PG', 'R'].includes(entry.attributes?.ageRating))
    .map(edgeItem).filter(entry => entry.type === type && entry.title);
  const count = Number(data.meta?.count);
  return { page, total_pages: Number.isFinite(count) ? Math.max(1, Math.min(500, Math.ceil(count / 20))) : data.links?.next ? Math.min(page + 1, 500) : page,
    items, ...(category === 'upcoming' && !query ? { notice: 'Upcoming titles may not have released episodes or playback sources yet.' } : {}) };
}
async function kitsuCatalog({ type, category, query, page, genre = '' }, { fetchText = readText } = {}) {
  if (genre && !ANIME_GENRES.includes(genre)) throw fail('Invalid Anime genre');
  if (query || genre || ['airing', 'new_releases', 'completed', 'upcoming'].includes(category)) {
    return edgeCatalog({ type, category, query, page, genre }, fetchText);
  }
  const catalog = category === 'trending' ? 'kitsu-anime-trending' : category === 'top_rated' ? 'kitsu-anime-rating' : 'kitsu-anime-popular';
  const extra = new URLSearchParams({ skip: String((page - 1) * 20) });
  const data = await json(`${BASE}catalog/anime/${catalog}/${extra}.json`, fetchText);
  if (!Array.isArray(data.metas)) throw new Error('Invalid Anime catalog');
  const pageMetas = category === 'trending' ? data.metas.filter(m => m.type === type).slice((page - 1) * 20, page * 20) : data.metas.slice(0, 20);
  const candidates = [...new Map(pageMetas.filter(acceptable).map((m) => [m.id, m])).values()];
  const allowed = await safeIds(candidates.map((m) => m.id), fetchText);
  return { page, total_pages: category === 'trending' ? Math.max(1, Math.ceil(data.metas.filter(m => m.type === type).length / 20)) : data.metas.length >= 20 ? Math.min(page + 1, 500) : page,
    items: candidates.filter((m) => m.type === type && allowed.has(m.id)).map(item) };
}
async function kitsuDetails(id, type, { fetchText = readText } = {}) {
  if (!kitsuId(id) || !['movie', 'series'].includes(type)) throw fail('Invalid Kitsu Anime identifier');
  const [response, allowed] = await Promise.all([
    json(`${BASE}meta/${type}/${encodeURIComponent(id)}.json`, fetchText), safeIds([id], fetchText),
  ]);
  const meta = response.meta;
  if (!acceptable(meta) || meta.id !== id || meta.type !== type || !allowed.has(id)) throw fail('Anime title unavailable', 404);
  const videos = [], seen = new Set();
  for (const video of (Array.isArray(meta.videos) ? meta.videos : []).slice(0, 10000)) {
    if (typeof video.id !== 'string' || !(video.id === id || new RegExp(`^${id}:[1-9]\\d{0,4}$`).test(video.id)) || seen.has(video.id)) continue;
    const absolute = video.id === id ? 1 : Number(video.id.split(':')[2]);
    if (!Number.isInteger(absolute) || absolute > 10000) continue;
    seen.add(video.id);
    videos.push({ video_id: video.id, number: absolute, season: 1, absolute_episode: absolute,
      name: String(video.title || `Episode ${absolute}`).slice(0, 200), overview: String(video.overview || '').slice(0, 10000),
      still: image(video.thumbnail), runtime: minutes(video.runtime || meta.runtime), released: video.released || null,
      ...(Number.isInteger(video.imdbSeason) && Number.isInteger(video.imdbEpisode) ? { mapped_season: video.imdbSeason, mapped_episode: video.imdbEpisode } : {}) });
  }
  videos.sort((a, b) => a.number - b.number);
  return { ...item(meta), stream_id: id, episodes: videos,
    seasons: type === 'series' && videos.length ? [{ number: 1, name: 'Episodes', episode_count: videos.length }] : [] };
}
async function canonicalKitsuSearch(input, options) {
  const detail = await kitsuDetails(input.kitsu_id, input.type, options);
  const video = input.type === 'series' ? detail.episodes.find((e) => e.video_id === input.video_id && e.number === input.episode_int && input.season_int === 1) : null;
  if (input.type === 'series' && !video) throw fail('Anime episode unavailable', 404);
  if (video?.released && Date.parse(video.released) > Date.now()) throw fail('Anime episode has not aired yet', 404);
  return { type: input.type, section: 'anime', kitsu_id: detail.id, stream_id: video?.video_id || detail.stream_id,
    title: detail.original_title, title_lower: detail.original_title.toLowerCase(), imdb_id: '', video_id: video?.video_id,
    ...(video ? { season_int: 1, episode_int: video.number, absolute_episode: video.absolute_episode,
      mapped_season: video.mapped_season, mapped_episode: video.mapped_episode } : {}),
    duration_seconds: (video?.runtime || detail.runtime || 24) * 60 };
}
module.exports = { kitsuId, kitsuCatalog, kitsuDetails, canonicalKitsuSearch, safeIds, kitsuItem: item };
