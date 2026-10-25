const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { getSportsEvents } = require('../utils/sportsEvents.cjs');
const { resolveSportsChannels } = require('../utils/sportsChannels.cjs');

function createSportsEventsRouter({ auth = authJwt, load = getSportsEvents, resolveChannels = resolveSportsChannels,
  readSettings = device => require('../utils/movieSettings.cjs').readMovieSettings(device) } = {}) {
  const router = Router();
  router.get('/sports/events', auth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const query = req.query?.q ?? '';
    if (typeof query !== 'string' || query.length > 100 || /[\x00-\x1f]/.test(query)) return res.status(400).json({ error: 'Enter a search of up to 100 characters' });
    try {
      const settings = await readSettings(req.device.device_id);
      if (settings.sports_enabled !== true) return res.status(403).json({ error: 'Sports is disabled for this device' });
      return res.json(await load({ query: query.trim() }));
    }
    catch { return res.status(503).json({ error: 'Sports events temporarily unavailable' }); }
  });
  router.get('/sports/events/:id/channels', auth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return res.json(await resolveChannels(req.device.device_id, req.params.id)); }
    catch (error) {
      const status = [400, 403, 404].includes(error.status) ? error.status : 503;
      return res.status(status).json({ error: status === 503 ? 'Live TV channels temporarily unavailable' : error.message });
    }
  });
  return router;
}
module.exports = createSportsEventsRouter();
module.exports.createSportsEventsRouter = createSportsEventsRouter;
