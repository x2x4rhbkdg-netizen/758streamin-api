const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { resolveMovieSource } = require('../utils/movieResolver.cjs');
const { requireDiscoveredSource } = require('../utils/movieSourceSessions.cjs');
const router = Router();
const active = new Set();
router.post('/movies/resolve', authJwt, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const device = String(req.device.device_id);
  if (active.has(device) || active.size >= 4) return res.status(429).json({ error: 'Playback preparation is busy. Try again shortly.' });
  active.add(device);
  try {
    const settings = await readMovieSettings(req.device.device_id);
    if (settings.enabled !== true) return res.status(403).json({ error: 'Movies and Series are disabled for this device' });
    const input = requireDiscoveredSource(req.device.device_id, req.body);
    return res.json(await resolveMovieSource(settings, input));
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.status ? error.message : 'Movie playback temporarily unavailable' });
  } finally { active.delete(device); }
});
module.exports = router;
