const { Router } = require('express');
const { replaceDeviceCode } = require('../utils/replaceDeviceCode.cjs');

function createDeviceCodeRouter({ db, authenticate, onError }) {
  const router = Router();
  router.patch('/devices/:code/code', authenticate, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!req.body || Object.keys(req.body).some(key => key !== 'device_code')) return res.status(400).json({ error: 'Send only the new device_code.' });
      return res.json(await replaceDeviceCode({ db, admin: req.admin, code: req.params.code, newCode: req.body.device_code }));
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
      return onError(req, res, 'admin/devices/code', error);
    }
  });
  return router;
}
module.exports = { createDeviceCodeRouter };
