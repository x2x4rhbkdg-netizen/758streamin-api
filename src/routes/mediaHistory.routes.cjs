const { Router } = require('express');
const { authJwt } = require('../middleware/authJwt.cjs');
const { createMediaHistoryStore, normalizeHistory } = require('../utils/mediaHistory.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');

function createMediaHistoryRouter({ auth = authJwt, store = createMediaHistoryStore(), readSettings = readMovieSettings } = {}) {
  const router = Router();
  const rates = new Map();
  router.use('/media/history', auth, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const now = Date.now(), id = String(req.device.device_id);
    for (const [key, value] of rates) if (value.expires <= now) rates.delete(key);
    const rate = rates.get(id) || { count: 0, expires: now + 60000 };
    if (++rate.count > 60 || !rates.has(id) && rates.size >= 10000) return res.status(429).json({ error: 'History requests are busy' });
    rates.set(id, rate); next();
  });
  router.get('/media/history', async (req, res) => {
    try {
      const owner = await store.owner(req.device.device_id);
      const settings = await readSettings(req.device.device_id);
      const sections = [...(settings.enabled === true ? ['movies', 'series'] : []), ...(settings.anime_enabled === true ? ['anime'] : [])];
      if (!sections.length) return res.status(403).json({ error: 'Media history is disabled for this device' });
      return res.json({ account_key: owner, allowed_sections: sections, entries: await store.list(owner, sections) });
    } catch (error) { return res.status(error.status || 503).json({ error: error.status ? error.message : 'History sync unavailable' }); }
  });
  router.put('/media/history', async (req, res) => {
    try {
      const owner = await store.owner(req.device.device_id);
      if (req.body?.account_key !== owner) return res.status(409).json({ error: 'History account changed. Refresh history before saving.' });
      const entries = req.body?.entries;
      if (!Array.isArray(entries) || !entries.length || entries.length > 20) return res.status(400).json({ error: 'Send 1 to 20 history entries' });
      const valid = entries.map(entry => normalizeHistory(entry));
      const settings = await readSettings(req.device.device_id);
      if (valid.some(record => record.section === 'anime' ? settings.anime_enabled !== true : settings.enabled !== true))
        return res.status(403).json({ error: 'Media history is disabled for this device' });
      for (const record of valid) await store.put(owner, record.section, record.key, record.entry);
      return res.json({ ok: true, account_key: owner, entries: valid.map(record => record.entry) });
    } catch (error) { return res.status(error.status || 503).json({ error: error.status ? error.message : 'History sync unavailable' }); }
  });
  return router;
}
module.exports = createMediaHistoryRouter();
module.exports.createMediaHistoryRouter = createMediaHistoryRouter;
