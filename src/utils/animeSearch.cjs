const { request, safe, item, FIELDS } = require('./anilistCatalog.cjs');
const bad = message => Object.assign(new Error(message), { status: 400 });
const SORTS = { popularity: 'POPULARITY_DESC', score: 'SCORE_DESC', trending: 'TRENDING_DESC', newest: 'START_DATE_DESC', oldest: 'START_DATE', title: 'TITLE_ROMAJI', favourites: 'FAVOURITES_DESC' };
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'];
const STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
const KEYS = ['genres', 'tags', 'format', 'availability', 'year', 'season', 'status', 'studio', 'minDuration', 'maxDuration', 'minEpisodes', 'maxEpisodes', 'sort'];
function parseAnimeFilters(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) throw bad('Invalid anime filters');
  let value;
  try { value = JSON.parse(raw); } catch { throw bad('Invalid anime filters'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !KEYS.includes(key))) throw bad('Invalid anime filters');
  const result = {};
  for (const key of ['genres', 'tags']) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > 10 || list.some(text => typeof text !== 'string' || !text.trim() || text.length > 80 || /[\x00-\x1f]/.test(text))) throw bad(`Invalid anime ${key}`);
    result[key] = [...new Set(list.map(text => text.trim()))];
  }
  for (const [key, choices, fallback] of [['format', FORMATS, ''], ['status', STATUSES, ''], ['season', ['WINTER', 'SPRING', 'SUMMER', 'FALL'], ''], ['availability', ['all', 'released', 'upcoming'], 'all'], ['sort', Object.keys(SORTS), 'popularity']]) {
    const selected = value[key] || fallback;
    if (selected !== '' && !choices.includes(selected)) throw bad(`Invalid anime ${key}`);
    result[key] = selected;
  }
  for (const [key, min, max] of [['year', 1900, 2100], ['studio', 1, 2147483647], ['minDuration', 0, 600], ['maxDuration', 0, 600], ['minEpisodes', 0, 100000], ['maxEpisodes', 0, 100000]]) {
    const number = value[key];
    if (number === '' || number === undefined || number === null) continue;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw bad(`Invalid anime ${key}`);
    result[key] = number;
  }
  for (const name of ['Duration', 'Episodes']) if (result[`min${name}`] !== undefined && result[`max${name}`] !== undefined && result[`min${name}`] > result[`max${name}`]) throw bad(`Minimum ${name.toLowerCase()} exceeds maximum`);
  if (result.availability === 'released' && result.status === 'NOT_YET_RELEASED' || result.availability === 'upcoming' && result.status && result.status !== 'NOT_YET_RELEASED') throw bad('Availability and status conflict');
  return result;
}
const SEARCH = `query StreamINAnimeSearch($page: Int!, $search: String, $formats: [MediaFormat], $genres: [String], $tags: [String], $status: MediaStatus, $statusNot: MediaStatus,
  $season: MediaSeason, $year: String, $minDuration: Int, $maxDuration: Int, $minEpisodes: Int, $maxEpisodes: Int, $sort: [MediaSort], $ids: [Int]) {
  Page(page: $page, perPage: 25) { pageInfo { hasNextPage }
    media(type: ANIME, isAdult: false, search: $search, format_in: $formats, genre_in: $genres, tag_in: $tags, status: $status, status_not: $statusNot,
      season: $season, startDate_like: $year, duration_greater: $minDuration, duration_lesser: $maxDuration,
      episodes_greater: $minEpisodes, episodes_lesser: $maxEpisodes, sort: $sort, id_in: $ids) { ${FIELDS} }
  }
}`;
const STUDIO_MEDIA = `query StreamINStudioMedia($id: Int!, $page: Int!, $sort: [MediaSort]) {
  Studio(id: $id) { media(page: $page, perPage: 25, sort: $sort) { pageInfo { hasNextPage } nodes { id type isAdult } } }
}`;
const OPTIONS = `query StreamINAnimeFilterOptions($search: String, $page: Int!) {
  GenreCollection MediaTagCollection { name isAdult }
  Page(page: $page, perPage: 50) { pageInfo { hasNextPage } studios(search: $search, sort: FAVOURITES_DESC) { id name isAnimationStudio } }
}`;
async function animeFilterOptions({ search = '', page = 1 } = {}, options = {}) {
  if (typeof search !== 'string' || search.length > 80 || !Number.isInteger(page) || page < 1 || page > 100) throw bad('Invalid studio search');
  const data = await (options.request || request)(OPTIONS, { search: search.trim() || undefined, page });
  if (!Array.isArray(data.GenreCollection) || !Array.isArray(data.MediaTagCollection) || !Array.isArray(data.Page?.studios)) throw Object.assign(new Error('Anime filter options unavailable'), { status: 502 });
  const clean = values => values.filter(value => typeof value === 'string' && value.length <= 80).sort();
  return { genres: clean(data.GenreCollection.filter(name => !/^(hentai|ecchi)$/i.test(name))),
    tags: clean(data.MediaTagCollection.filter(tag => tag.isAdult === false).map(tag => tag.name)),
    studios: data.Page.studios.filter(studio => Number.isSafeInteger(studio.id) && studio.id > 0 && typeof studio.name === 'string' && studio.isAnimationStudio === true).map(studio => ({ id: studio.id, name: studio.name.slice(0, 100) })),
    page, has_next_page: data.Page.pageInfo?.hasNextPage === true };
}
async function searchAnime({ type, query = '', page = 1, filters }, options = {}) {
  if (!['movie', 'series'].includes(type) || typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 200) throw bad('Invalid anime search');
  const f = parseAnimeFilters(JSON.stringify(filters)), run = options.request || request;
  if (f.format && (f.format === 'MOVIE') !== (type === 'movie')) throw bad('Format does not match the selected anime type');
  const variables = { page, search: query.trim() || undefined, formats: f.format ? [f.format] : type === 'movie' ? ['MOVIE'] : FORMATS.filter(format => format !== 'MOVIE'),
    genres: f.genres.length ? f.genres : undefined, tags: f.tags.length ? f.tags : undefined,
    status: f.status || (f.availability === 'upcoming' ? 'NOT_YET_RELEASED' : undefined),
    statusNot: f.availability === 'released' ? 'NOT_YET_RELEASED' : undefined,
    season: f.season || undefined, year: f.year ? `${f.year}%` : undefined, sort: [SORTS[f.sort], 'ID'],
  };
  // AniList bounds are exclusive; the UI promises inclusive minimums and maximums.
  for (const name of ['Duration', 'Episodes']) {
    if (f[`min${name}`] > 0) variables[`min${name}`] = f[`min${name}`] - 1;
    if (f[`max${name}`] !== undefined) variables[`max${name}`] = f[`max${name}`] + 1;
  }
  let more;
  if (f.studio) {
    // Studio.media is the public studio filter. Intersect its paged IDs with every other filter.
    const data = await run(STUDIO_MEDIA, { id: f.studio, page, sort: variables.sort });
    if (!Array.isArray(data.Studio?.media?.nodes)) throw Object.assign(new Error('Studio catalog unavailable'), { status: 502 });
    variables.ids = data.Studio.media.nodes.filter(node => node.type === 'ANIME' && node.isAdult === false && Number.isSafeInteger(node.id) && node.id > 0).map(node => node.id);
    more = data.Studio.media.pageInfo?.hasNextPage === true;
    variables.page = 1;
    if (!variables.ids.length) return { items: [], page, total_pages: more && page < 200 ? page + 1 : page, metadata_provider: 'anilist' };
  }
  const data = await run(SEARCH, variables);
  if (!Array.isArray(data.Page?.media)) throw Object.assign(new Error('Anime search unavailable'), { status: 502 });
  const seen = new Set();
  const items = data.Page.media.filter(safe).map(item).filter(value => value.type === type && value.title && !seen.has(value.id) && seen.add(value.id));
  return { items, page, total_pages: (more ?? data.Page.pageInfo?.hasNextPage) && page < 200 ? page + 1 : page, metadata_provider: 'anilist' };
}
module.exports = { parseAnimeFilters, animeFilterOptions, searchAnime };
