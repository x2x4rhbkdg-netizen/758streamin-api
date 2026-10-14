const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { resolveMovieSource } = require('../utils/movieResolver.cjs');
const { requireDiscoveredSource } = require('../utils/movieSourceSessions.cjs');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { requireCatalogAccess } = require('../utils/animeCatalog.cjs');
const router = Router();
const active = new Set();
router.post('/movies/resolve', authJwt, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const device = String(req.device.device_id);
  if (active.has(device) || active.size >= 4) return res.status(429).json({ error: 'Playback preparation is busy. Try again shortly.' });
  active.add(device);
  try {
    const settings = await readMovieSettings(req.device.device_id);
    const input = requireDiscoveredSource(req.device.device_id, req.body);
    // The signed source capability, not a client-supplied section, determines access.
    requireCatalogAccess(settings, input.section);
    const result = await resolveMovieSource(settings, input);
    if (result.protectedPlaybackUrl) {
      const base = new URL(process.env.MOVIE_PLAYBACK_BASE_URL || 'https://api.758streamin.com');
      if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid movie playback base URL');
      const ticket = createPlaybackTickets(process.env.JWT_SECRET).issue(result.protectedPlaybackUrl, req.device.device_id, input.section);
      return res.json({ provider: result.provider, playbackUrl: new URL(`/v1/movies/stream/${ticket}`, base).href });
    }
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.status ? error.message : 'Movie playback temporarily unavailable' });
  } finally { active.delete(device); }
});
module.exports = router;
