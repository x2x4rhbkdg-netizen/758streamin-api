const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { getSportsEvents } = require('../utils/sportsEvents.cjs');

function createSportsEventsRouter({ auth = authJwt, load = getSportsEvents } = {}) {
  const router = Router();
  router.get('/sports/events', auth, async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return res.json(await load()); }
    catch { return res.status(503).json({ error: 'Sports events temporarily unavailable' }); }
  });
  return router;
}
module.exports = createSportsEventsRouter();
module.exports.createSportsEventsRouter = createSportsEventsRouter;
