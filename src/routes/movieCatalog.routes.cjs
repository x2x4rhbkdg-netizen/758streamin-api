const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { tmdb } = require('../utils/tmdbCatalog.cjs');
const { catalogSection, requireCatalogAccess, requireAnime } = require('../utils/animeCatalog.cjs');
const { kitsuCatalog, kitsuDetails } = require('../utils/kitsuCatalog.cjs');
const { anilistCatalog, anilistDetails } = require('../utils/anilistCatalog.cjs');
const { jikanCatalog, jikanDetails } = require('../utils/jikanCatalog.cjs');
const { listAddonCatalogs, browseAddonCatalog } = require('../utils/stremioCatalogs.cjs');
const streamingServices = require('../utils/streamingServices.cjs');

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function contentType(value) {
  if (!['movie', 'series'].includes(value)) throw bad('type must be movie or series');
  return value === 'series' ? 'tv' : 'movie';
}
function integer(value, min = 1, max = 2147483647) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw bad('Invalid movie catalog identifier');
  return number;
}
function artwork(path, size = 'w342') {
  return typeof path === 'string' && /^\/[a-zA-Z0-9_.-]+$/.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
function item(data, type) {
  return { id: data.id, type, title: data.title || data.name || '',
    original_title: data.original_title || data.original_name || data.title || data.name || '',
    year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    overview: data.overview || '', poster: artwork(data.poster_path), rating: data.vote_average || 0 };
}
function createMovieCatalogRouter({ auth = authJwt, readSettings = readMovieSettings, request = tmdb, animeCatalog = anilistCatalog, fallbackAnimeCatalog = kitsuCatalog, jikanAnimeCatalog = jikanCatalog, jikanAnimeDetails = jikanDetails, animeDetails = kitsuDetails, primaryAnimeDetails = anilistDetails,
  addonCatalogs = listAddonCatalogs, addonBrowse = browseAddonCatalog } = {}) {
  const router = Router();
  router.use('/movies', auth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      req.movieSettings = await readSettings(req.device.device_id);
      req.catalogSection = catalogSection(req.query.section);
      requireCatalogAccess(req.movieSettings, req.catalogSection);
      next();
    } catch (error) { return res.status(error.status || 502).json({ error: error.status ? error.message : 'Movie settings unavailable' }); }
  });
  const handle = (run) => async (req, res) => {
    try { return res.json(await run(req)); }
    catch (error) { return res.status(error.status || 502).json({ error: error.status ? error.message : 'Movie catalog temporarily unavailable' }); }
  };
  const requireTmdb = (req) => {
    if (!req.movieSettings.tmdb_read_access_token) throw bad('Configure the TMDB Read Access Token in Media Settings first', 409);
  };
  router.get('/movies/addon-catalogs', handle(async (req) => {
    const type = req.query.type || 'movie';
    contentType(type);
    return addonCatalogs(req.movieSettings, { type, section: req.catalogSection });
  }));
  router.get('/movies/streaming-services', handle(async (req) => {
    if (req.catalogSection === 'anime') throw bad('Streaming services are for Movies and Series');
    requireTmdb(req);
    const list = await streamingServices.services(req.movieSettings, contentType(req.query.type || 'movie'), request);
    return { services: list.map(({ regions, ...value }) => value) };
  }));
  router.get('/movies/catalog', handle(async (req) => {
    const type = req.query.type || 'movie';
    const endpoint = contentType(type);
    const page = integer(req.query.page || 1, 1, 500);
    const query = String(req.query.q || '').trim();
    if (query.length > 200) throw bad('Search query is too long');
    if (req.query.streaming_service && (req.catalogSection === 'anime' || req.query.addon_catalog)) throw bad('Invalid streaming service scope');
    if (req.query.addon_catalog) return addonBrowse(req.movieSettings, { type, section: req.catalogSection,
      key: req.query.addon_catalog, page, query, genre: req.query.genre || '' });
    const category = req.query.category || 'popular';
    const anime = req.catalogSection === 'anime';
    const categories = anime ? ['popular', 'top_rated', 'trending', 'airing', 'latest_episodes', 'new_releases', 'completed', 'upcoming'] : ['popular', 'top_rated'];
    if (!categories.includes(category)) throw bad('Invalid movie category');
    if (anime) {
      const filters = { type, category, query, page, genre: String(req.query.genre || '') };
      const adapters = { anilist: animeCatalog, kitsu: fallbackAnimeCatalog, jikan: jikanAnimeCatalog };
      const names = { anilist: 'AniList', kitsu: 'Kitsu', jikan: 'Jikan' };
      const primary = Object.hasOwn(adapters, req.movieSettings.anime_primary_catalog) ? req.movieSettings.anime_primary_catalog : 'anilist';
      let failure;
      for (const provider of new Set([primary, 'kitsu', 'anilist', 'jikan'])) {
        try {
          const result = await adapters[provider]({ ...filters, category: provider === 'kitsu' && category === 'latest_episodes' ? 'airing' : category });
          return { ...result, metadata_provider: provider, notice: [
            provider !== primary ? `${names[primary]} is temporarily unavailable. Showing ${names[provider]} titles.` : '',
            provider === 'kitsu' && category === 'latest_episodes' ? 'Showing currently airing titles instead of the latest-episode feed.' : '',
            result.notice || '',
          ].filter(Boolean).join(' ') };
        } catch (error) {
          if (error.status && ![502, 503, 504].includes(error.status)) throw error;
          failure = error;
        }
      }
      throw failure;
    }
    requireTmdb(req);
    if (req.query.streaming_service) {
      const data = await streamingServices.browse(req.movieSettings, endpoint, request, {
        service: integer(req.query.streaming_service), page, category, query,
      });
      return { page, total_pages: data.total_pages, items: data.results.map(value => item(value, type)), ...(data.notice ? { notice: data.notice } : {}) };
    }
    const data = await request(req.movieSettings, query ? `search/${endpoint}` : `${endpoint}/${category}`, {
      page, include_adult: false, ...(query ? { query } : {}),
    });
    const results = (Array.isArray(data.results) ? data.results : []).filter((value) => !value.adult);
    return { page, total_pages: Math.min(Number(data.total_pages) || 1, 500),
      items: results.map((value) => item(value, type)) };
  }));
  router.get('/movies/details/:id', handle(async (req) => {
    const type = req.query.type || 'movie';
    if (req.catalogSection === 'anime' && String(req.params.id).startsWith('mal:')) return jikanAnimeDetails(req.params.id, type);
    if (req.catalogSection === 'anime' && String(req.params.id).startsWith('anilist:')) return primaryAnimeDetails(req.params.id, type);
    if (req.catalogSection === 'anime' && String(req.params.id).startsWith('kitsu:')) return animeDetails(req.params.id, type);
    requireTmdb(req);
    const data = await request(req.movieSettings, `${contentType(type)}/${integer(req.params.id)}`, { append_to_response: 'external_ids' });
    if (data.adult) throw bad('Title unavailable', 404);
    if (req.catalogSection === 'anime') requireAnime(data);
    return { ...item(data, type), ...(req.catalogSection === 'anime' ? { section: 'anime' } : {}), imdb_id: data.imdb_id || data.external_ids?.imdb_id || '',
      runtime: data.runtime || data.episode_run_time?.[0] || 0,
      seasons: (Array.isArray(data.seasons) ? data.seasons : []).map((season) => ({ number: season.season_number, name: season.name, episode_count: season.episode_count })) };
  }));
  router.get('/movies/season/:id/:season', handle(async (req) => {
    if (req.catalogSection === 'anime' && String(req.params.id).startsWith('mal:')) {
      if (integer(req.params.season, 0, 1000) !== 1) throw bad('Anime episode group unavailable', 404);
      const detail = await jikanAnimeDetails(req.params.id, 'series');
      return { episodes: detail.episodes, ...(detail.notice ? { notice: detail.notice } : {}) };
    }
    if (req.catalogSection === 'anime' && String(req.params.id).startsWith('anilist:')) {
      if (integer(req.params.season, 0, 1000) !== 1) throw bad('Anime episode group unavailable', 404);
      const detail = await primaryAnimeDetails(req.params.id, 'series');
      return { episodes: detail.episodes, ...(detail.notice ? { notice: detail.notice } : {}) };
    }
    if (req.catalogSection === 'anime' && String(req.params.id).startsWith('kitsu:')) {
      if (integer(req.params.season, 0, 1000) !== 1) throw bad('Anime episode group unavailable', 404);
      return { episodes: (await animeDetails(req.params.id, 'series')).episodes };
    }
    requireTmdb(req);
    const id = integer(req.params.id);
    const season = integer(req.params.season, 0, 1000);
    const series = await request(req.movieSettings, `tv/${id}`);
    if (series.adult) throw bad('Title unavailable', 404);
    if (req.catalogSection === 'anime') requireAnime(series);
    const data = await request(req.movieSettings, `tv/${id}/season/${season}`);
    return { episodes: (Array.isArray(data.episodes) ? data.episodes : []).map((episode) => ({
      number: episode.episode_number, name: episode.name, overview: episode.overview || '', runtime: episode.runtime || 0,
    })) };
  }));
  return router;
}
module.exports = createMovieCatalogRouter();
module.exports.createMovieCatalogRouter = createMovieCatalogRouter;
