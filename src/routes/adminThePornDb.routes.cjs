const { Router } = require('express');
const { createThePornDbClient } = require('../utils/thePornDb.cjs');
function createThePornDbAdminRouter({ authenticate, authorize, readSettings, client = createThePornDbClient(), now = Date.now }) {
  const router = Router(), attempts = new Map();
  router.post('/movie-settings/theporndb/test', authenticate, async (req, res) => {
    if (!authorize(req, res)) return;
    res.set('Cache-Control', 'no-store');
    const time = now(), admin = String(req.admin.id || 'api-key');
    for (const [id, expires] of attempts) if (expires <= time) attempts.delete(id);
    if (attempts.has(admin) || attempts.size >= 1000) return res.status(429).json({ error: 'Wait before testing ThePornDB again' });
    attempts.set(admin, time + 5000);
    try {
      const token = Object.hasOwn(req.body || {}, 'token') ? req.body.token : (await readSettings()).theporndb_token;
      return res.json(await client.test(token));
    } catch (error) {
      return res.status([400, 404, 409, 429].includes(error.status) ? error.status : 502)
        .json({ error: error.status ? error.message : 'ThePornDB test unavailable' });
    }
  });
  return router;
}
module.exports = { createThePornDbAdminRouter };
