const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { tmdb } = require('../utils/tmdbCatalog.cjs');
const { catalogSection, requireCatalogAccess, requireAnime } = require('../utils/animeCatalog.cjs');

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
function createMovieCatalogRouter({ auth = authJwt, readSettings = readMovieSettings, request = tmdb } = {}) {
  const router = Router();
  router.use('/movies', auth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      req.movieSettings = await readSettings(req.device.device_id);
      req.catalogSection = catalogSection(req.query.section);
      requireCatalogAccess(req.movieSettings, req.catalogSection);
      if (!req.movieSettings.tmdb_read_access_token) return res.status(409).json({ error: 'Configure the TMDB Read Access Token in Movie Settings first' });
      next();
    } catch (error) { return res.status(error.status || 502).json({ error: error.status ? error.message : 'Movie settings unavailable' }); }
  });
  const handle = (run) => async (req, res) => {
    try { return res.json(await run(req)); }
    catch (error) { return res.status(error.status || 502).json({ error: error.status ? error.message : 'Movie catalog temporarily unavailable' }); }
  };
  router.get('/movies/catalog', handle(async (req) => {
    const type = req.query.type || 'movie';
    const endpoint = contentType(type);
    const page = integer(req.query.page || 1, 1, 500);
    const query = String(req.query.q || '').trim();
    if (query.length > 200) throw bad('Search query is too long');
    const category = req.query.category || 'popular';
    if (!['popular', 'top_rated'].includes(category)) throw bad('Invalid movie category');
    const anime = req.catalogSection === 'anime';
    const data = await request(req.movieSettings, query ? `search/${endpoint}` : anime ? `discover/${endpoint}` : `${endpoint}/${category}`, {
      page, include_adult: false, ...(query ? { query } : anime ? {
        with_genres: '16', with_origin_country: 'JP', sort_by: category === 'top_rated' ? 'vote_average.desc' : 'popularity.desc',
        ...(category === 'top_rated' ? { 'vote_count.gte': 100 } : {}),
      } : {}),
    });
    let results = (Array.isArray(data.results) ? data.results : []).filter((value) => !value.adult);
    if (anime && query) {
      // Search has no genre/country filters. Verify candidates server-side rather than trusting the client.
      const verified = [];
      const candidates = results.filter((value) => value.genre_ids?.includes(16)).slice(0, 20);
      for (let index = 0; index < candidates.length; index += 5) {
        const batch = await Promise.all(candidates.slice(index, index + 5).map(async (value) => {
          const detail = await request(req.movieSettings, `${endpoint}/${integer(value.id)}`);
          try { requireAnime(detail); return value; } catch { return null; }
        }));
        verified.push(...batch.filter(Boolean));
      }
      results = verified;
    }
    return { page, total_pages: Math.min(Number(data.total_pages) || 1, 500),
      items: results.map((value) => ({ ...item(value, type), ...(anime ? { section: 'anime' } : {}) })) };
  }));
  router.get('/movies/details/:id', handle(async (req) => {
    const type = req.query.type || 'movie';
    const data = await request(req.movieSettings, `${contentType(type)}/${integer(req.params.id)}`, { append_to_response: 'external_ids' });
    if (data.adult) throw bad('Title unavailable', 404);
    if (req.catalogSection === 'anime') requireAnime(data);
    return { ...item(data, type), ...(req.catalogSection === 'anime' ? { section: 'anime' } : {}), imdb_id: data.imdb_id || data.external_ids?.imdb_id || '',
      runtime: data.runtime || data.episode_run_time?.[0] || 0,
      seasons: (Array.isArray(data.seasons) ? data.seasons : []).map((season) => ({ number: season.season_number, name: season.name, episode_count: season.episode_count })) };
  }));
  router.get('/movies/season/:id/:season', handle(async (req) => {
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
