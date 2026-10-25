const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { getSportsEvents } = require('../utils/sportsEvents.cjs');
const { resolveSportsChannels } = require('../utils/sportsChannels.cjs');

function createSportsEventsRouter({ auth = authJwt, load = getSportsEvents, resolveChannels = resolveSportsChannels } = {}) {
  const router = Router();
  router.get('/sports/events', auth, async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return res.json(await load()); }
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
