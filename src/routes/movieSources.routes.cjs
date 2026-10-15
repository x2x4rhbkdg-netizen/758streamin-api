const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { discoverSources, validateSearch } = require('../utils/Scraper.cjs');
const { lookupProviders } = require('../utils/movieResolver.cjs');
const { issueSource } = require('../utils/movieSourceSessions.cjs');
const { tmdb } = require('../utils/tmdbCatalog.cjs');
const { requireCatalogAccess, requireAnime } = require('../utils/animeCatalog.cjs');
const { canonicalKitsuSearch } = require('../utils/kitsuCatalog.cjs');

function createMovieSourcesRouter({ auth = authJwt, readSettings = readMovieSettings, discover = discoverSources,
  lookup = lookupProviders, issue = issueSource, request = tmdb, animeSearch = canonicalKitsuSearch } = {}) {
  const router = Router();
  const active = new Set();
  const recent = new Map();
  router.post('/movies/sources', auth, async (req, res) => {
    const deviceId = String(req.device.device_id);
    res.set('Cache-Control', 'no-store');
    try {
      let metadata = validateSearch(req.body);
      const settings = await readSettings(req.device.device_id);
      requireCatalogAccess(settings, metadata.section);
      if ((!settings.scraper_url || metadata.kitsu_id) && !settings.stremio_addons?.some((a) => a.enabled && a.scopes.includes(metadata.section === 'anime' ? 'anime' : metadata.type))) {
        return res.status(409).json({ error: metadata.kitsu_id ? 'Enable a Kitsu-compatible Stremio source add-on for Anime in Media Settings' : 'Configure a Scraper URL or enable a Stremio add-on for this section' });
      }
      const now = Date.now();
      for (const [key, timestamp] of recent) if (now - timestamp > 60000) recent.delete(key);
      if (active.has(deviceId) || active.size >= 4 || now - (recent.get(deviceId) || 0) < 10000 || recent.size >= 10000) {
        res.set('Retry-After', '10');
        return res.status(429).json({ error: 'Source search is busy. Try again shortly.' });
      }
      active.add(deviceId);
      recent.set(deviceId, now);
      try {
        if (metadata.kitsu_id) {
          metadata = await animeSearch(metadata);
        } else if (metadata.section === 'anime') {
          if (!settings.tmdb_read_access_token) return res.status(409).json({ error: 'Configure the TMDB Read Access Token first' });
          const data = requireAnime(await request(settings, `${metadata.type === 'series' ? 'tv' : 'movie'}/${metadata.tmdb_id}`, { append_to_response: 'external_ids' }));
          const title = data.original_title || data.original_name || data.title || data.name;
          metadata = { ...metadata, title, title_lower: title.toLowerCase(), imdb_id: data.imdb_id || data.external_ids?.imdb_id || '' };
        }
        const data = await discover(settings, metadata);
        const sources = Array.isArray(data.sources) ? data.sources : [];
        const providers = sources.length ? await lookup(settings, sources) : { available: {}, provider_status: {} };
        return res.json({ ...data, sources: sources.map((source) => ({ ...source, providers: providers.available[source.hash] || [],
          on_demand_providers: providers.on_demand?.[source.hash] || [],
          source_token: issue(req.device.device_id, source.hash, { ...metadata,
            ...(metadata.kitsu_id && source.file_name ? { file_name: source.file_name } : {}) }) })),
          provider_status: providers.provider_status });
      }
      finally { active.delete(deviceId); }
    } catch (error) {
      if ([400, 403, 404].includes(error.status)) return res.status(error.status).json({ error: error.message });
      // Never expose upstream URLs or credentials in diagnostics.
      return res.status(502).json({ error: 'Movie source discovery temporarily unavailable' });
    }
  });
  return router;
}

module.exports = createMovieSourcesRouter();
module.exports.createMovieSourcesRouter = createMovieSourcesRouter;
