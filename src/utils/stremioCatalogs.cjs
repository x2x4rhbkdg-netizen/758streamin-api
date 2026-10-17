const { createHash } = require('node:crypto');
const { readText } = require('./scraperHttp.cjs');
const { readAddonJson } = require('./stremioAddons.cjs');
const { catalogDefinitions } = require('./stremioCatalogManifest.cjs');
const { safeIds, kitsuId, kitsuItem } = require('./kitsuCatalog.cjs');
const { tmdb } = require('./tmdbCatalog.cjs');
const { isAnime } = require('./animeCatalog.cjs');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cache = new Map();
async function mapLimit(values, run) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (cursor < values.length) { const i = cursor++; output[i] = await run(values[i]); }
  }));
  return output;
}
async function loadCatalogs(settings, { type, section }, fetchText) {
  if (!['movie', 'series'].includes(type)) throw fail('Invalid catalog type');
  const addons = (settings.stremio_addons || []).filter((a) => a.enabled && !a.scopes.includes('adult') && a.scopes.includes(section === 'anime' ? 'anime' : type));
  return (await mapLimit(addons.slice(0, 10), async (addon) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const manifest = await readAddonJson(addon.manifest_url, fetchText, controller.signal);
      return catalogDefinitions(manifest).filter((c) => !['movie', 'series'].includes(c.type) || c.type === type).map((catalog) => {
        const extras = Array.isArray(catalog.extra) ? catalog.extra : [];
        return { addon, catalog,
          key: createHash('sha256').update(JSON.stringify([addon.id, addon.manifest_url, catalog.type, catalog.id])).digest('hex'),
          name: String(catalog.name || catalog.id).slice(0, 200), addon_name: addon.name,
          search: extras.some((e) => e.name === 'search'), search_required: extras.some((e) => e.name === 'search' && e.isRequired),
          genre_required: extras.some((e) => e.name === 'genre' && e.isRequired),
          genres: (extras.find((e) => e.name === 'genre')?.options || []).filter((v) => typeof v === 'string' && v.length <= 100).slice(0, 100) };
      });
    } catch { return []; } finally { clearTimeout(timer); }
  })).flat();
}
async function listAddonCatalogs(settings, options, { fetchText = readText } = {}) {
  return { catalogs: (await loadCatalogs(settings, options, fetchText)).map(({ addon, catalog, ...publicCatalog }) => publicCatalog) };
}
function safePreview(meta, type) {
  return meta && meta.type === type && typeof meta.id === 'string' && typeof meta.name === 'string' &&
    !meta.adult && !meta.nsfw && (meta.genres == null || Array.isArray(meta.genres)) &&
    !meta.genres?.some((g) => /^(adult|porn|hentai|erotica)$/i.test(String(g)));
}
async function canonicalPreview(settings, meta, type, request) {
  const id = String(meta.id);
  const key = createHash('sha256').update(JSON.stringify([settings.tmdb_read_access_token, type, id])).digest('hex');
  if (request === tmdb && cache.get(key)?.expires > Date.now()) return cache.get(key).value;
  let value;
  if (/^tt\d{5,12}$/.test(id)) {
    const result = await request(settings, `find/${id}`, { external_source: 'imdb_id' });
    const matches = result[type === 'movie' ? 'movie_results' : 'tv_results'];
    value = Array.isArray(matches) && matches.length === 1 ? matches[0] : null;
  } else if (/^tmdb:[1-9]\d{0,9}$/.test(id)) {
    value = await request(settings, `${type === 'series' ? 'tv' : 'movie'}/${id.slice(5)}`);
  }
  if (!value || value.adult !== false || !Number.isSafeInteger(value.id) || value.id < 1) return null;
  const poster = /^\/[a-zA-Z0-9_.-]+$/.test(value.poster_path || '') ? `https://image.tmdb.org/t/p/w342${value.poster_path}` : null;
  const item = { id: value.id, type, title: String(value.title || value.name || '').slice(0, 200),
    original_title: String(value.original_title || value.original_name || value.title || value.name || '').slice(0, 200),
    year: String(value.release_date || value.first_air_date || '').slice(0, 4),
    overview: String(value.overview || '').slice(0, 10000), poster, rating: Number(value.vote_average) || 0,
    verified_anime: isAnime(value) };
  if (request === tmdb) {
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    cache.set(key, { value: item, expires: Date.now() + 600000 });
  }
  return item;
}
async function browseAddonCatalog(settings, options, { fetchText = readText, request = tmdb, checkAnime = safeIds } = {}) {
  const { type, section, key, page = 1, query = '', genre = '' } = options;
  if (!/^[a-f0-9]{64}$/.test(String(key)) || !Number.isInteger(page) || page < 1 || page > 500 ||
      typeof query !== 'string' || query.length > 200 || typeof genre !== 'string' || genre.length > 100) throw fail('Invalid add-on catalog request');
  const selected = (await loadCatalogs(settings, options, fetchText)).find((c) => c.key === key);
  if (!selected) throw fail('Catalog is disabled or unavailable', 404);
  if (query && !selected.search) throw fail('This catalog does not support text search');
  if (selected.search_required && !query) return { page, total_pages: page, items: [], notice: 'Enter a search to browse this catalog.' };
  if (genre && !selected.genres.includes(genre)) throw fail('Invalid catalog genre');
  if (selected.genre_required && !genre) return { page, total_pages: page, items: [], notice: 'Choose a genre to browse this catalog.' };
  if (section !== 'anime' && !settings.tmdb_read_access_token) throw fail('Configure TMDB to verify catalog titles before browsing', 409);
  const size = Number.isInteger(selected.catalog.pageSize) ? Math.max(1, Math.min(100, selected.catalog.pageSize)) : 100;
  const displaySize = Math.min(20, size);
  const offset = (page - 1) * displaySize;
  const canSkip = selected.catalog.extra?.some((e) => e.name === 'skip');
  const skip = canSkip ? Math.floor(offset / size) * size : 0;
  const extras = new URLSearchParams({ ...(canSkip ? { skip: String(skip) } : {}), ...(query ? { search: query } : {}), ...(genre ? { genre } : {}) });
  const base = selected.addon.manifest_url.slice(0, -'manifest.json'.length);
  const url = `${base}catalog/${encodeURIComponent(selected.catalog.type)}/${encodeURIComponent(selected.catalog.id)}${extras.size ? `/${extras}` : ''}.json`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try { response = await readAddonJson(url, fetchText, controller.signal); }
  catch { throw fail('Add-on catalog temporarily unavailable', 502); }
  finally { clearTimeout(timer); }
  if (!Array.isArray(response.metas)) throw fail('Invalid add-on catalog response', 502);
  const raw = response.metas.slice(0, 100);
  const window = raw.slice(offset - skip, offset - skip + displaySize);
  const candidates = window.filter((m) => safePreview(m, type));
  let items;
  if (section === 'anime') {
    const anime = candidates.filter((m) => kitsuId(m.id));
    const allowed = await checkAnime(anime.map((m) => m.id), fetchText);
    const mapped = new Map(anime.filter((m) => allowed.has(m.id)).map((m) => [m.id, kitsuItem(m)]));
    if (settings.tmdb_read_access_token) {
      const verified = await mapLimit(candidates.filter((m) => !kitsuId(m.id)), async (m) => {
        const preview = await canonicalPreview(settings, m, type, request);
        if (preview && !preview.verified_anime) {
          const detail = await request(settings, `${type === 'series' ? 'tv' : 'movie'}/${preview.id}`);
          if (detail.id === preview.id && isAnime(detail) && detail.adult === false) return { ...preview, verified_anime: true };
        }
        return preview;
      });
      candidates.filter((m) => !kitsuId(m.id)).forEach((m, i) => {
        if (verified[i]?.verified_anime) mapped.set(m.id, { ...verified[i], section: 'anime', metadata_provider: 'tmdb' });
      });
    }
    items = candidates.map((m) => mapped.get(m.id)).filter(Boolean);
  } else {
    items = (await mapLimit(candidates, (m) => canonicalPreview(settings, m, type, request))).filter(Boolean);
  }
  const hasMore = offset - skip + displaySize < raw.length || (canSkip && raw.length >= size);
  return { page, total_pages: hasMore ? Math.min(page + 1, 500) : page,
    items: [...new Map(items.map((m) => [m.id, m])).values()], catalog_name: selected.name, catalog_provider: selected.addon_name,
    ...(!items.length && window.length ? { notice: section === 'anime' ? 'No verified Anime titles on this page. IMDb-based Anime lists require TMDB configuration.' : 'No supported, verified titles on this page.' } : {}) };
}
module.exports = { listAddonCatalogs, browseAddonCatalog };
