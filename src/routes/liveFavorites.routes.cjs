const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { createLiveFavoritesStore, normalizeLiveFavorite } = require('../utils/liveFavorites.cjs');
function createLiveFavoritesRouter({ auth = authJwt, store = createLiveFavoritesStore(), readSettings = readMovieSettings } = {}) {
  const router = Router(), rates = new Map();
  router.use('/live/favorites', auth, async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const now = Date.now(), device = String(req.device.device_id);
    for (const [key, value] of rates) if (value.expires <= now) rates.delete(key);
    const rate = rates.get(device) || { count: 0, expires: now + 60000 };
    if (++rate.count > 60 || !rates.has(device) && rates.size >= 10000) return res.status(429).json({ error: 'Favourite sync is busy' });
    rates.set(device, rate);
    try {
      const settings = await readSettings(req.device.device_id);
      if (settings.live_tv_enabled === false && settings.radio_enabled === false) return res.status(403).json({ error: 'Live TV and Radio are disabled' });
      next();
    } catch { return res.status(503).json({ error: 'Favourite sync unavailable' }); }
  });
  router.get('/live/favorites', async (req, res) => {
    try {
      const owner = await store.owner(req.device.device_id);
      return res.json({ account_key: owner, entries: await store.list(owner) });
    } catch { return res.status(503).json({ error: 'Favourite sync unavailable' }); }
  });
  router.put('/live/favorites', async (req, res) => {
    try {
      const owner = await store.owner(req.device.device_id);
      if (req.body?.account_key !== owner) return res.status(409).json({ error: 'Favourite account changed. Refresh before saving.' });
      const entries = req.body?.entries;
      if (!Array.isArray(entries) || !entries.length || entries.length > 100) return res.status(400).json({ error: 'Send 1 to 100 favourite changes' });
      const valid = entries.map(entry => normalizeLiveFavorite(entry));
      if (new Set(valid.map(entry => entry.stream_id)).size !== valid.length) return res.status(400).json({ error: 'Duplicate channel favourites' });
      for (const entry of valid) await store.put(owner, entry);
      const sent = new Set(valid.map(entry => entry.stream_id));
      return res.json({ ok: true, account_key: owner, entries: (await store.list(owner)).filter(entry => sent.has(entry.stream_id)) });
    } catch (error) { return res.status(error.status === 400 ? 400 : 503).json({ error: error.status === 400 ? error.message : 'Favourite sync unavailable' }); }
  });
  return router;
}
module.exports = createLiveFavoritesRouter();
module.exports.createLiveFavoritesRouter = createLiveFavoritesRouter;
