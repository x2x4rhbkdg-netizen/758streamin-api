const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { discoverSources, validateSearch } = require('../utils/Scraper.cjs');

function createMovieSourcesRouter({ auth = authJwt, readSettings = readMovieSettings, discover = discoverSources } = {}) {
  const router = Router();
  const active = new Set();
  const recent = new Map();
  router.post('/movies/sources', auth, async (req, res) => {
    const deviceId = String(req.device.device_id);
    res.set('Cache-Control', 'no-store');
    try {
      validateSearch(req.body);
      const settings = await readSettings(req.device.device_id);
      if (settings.enabled !== true) return res.status(403).json({ error: 'Movies and Series are disabled for this device' });
      if (!settings.scraper_url) return res.status(409).json({ error: 'Configure the global Scraper URL first' });
      const now = Date.now();
      for (const [key, timestamp] of recent) if (now - timestamp > 60000) recent.delete(key);
      if (active.has(deviceId) || active.size >= 4 || now - (recent.get(deviceId) || 0) < 10000 || recent.size >= 10000) {
        res.set('Retry-After', '10');
        return res.status(429).json({ error: 'Source search is busy. Try again shortly.' });
      }
      active.add(deviceId);
      recent.set(deviceId, now);
      try { return res.json(await discover(settings, req.body)); }
      finally { active.delete(deviceId); }
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      // Never expose upstream URLs or credentials in diagnostics.
      return res.status(502).json({ error: 'Movie source discovery temporarily unavailable' });
    }
  });
  return router;
}

module.exports = createMovieSourcesRouter();
module.exports.createMovieSourcesRouter = createMovieSourcesRouter;
