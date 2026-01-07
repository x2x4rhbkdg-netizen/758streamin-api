/** =========================================
 *  MIDDLEWARE: Admin API Key (CommonJS)
 *  Header: x-admin-key: <ADMIN_API_KEY>
 *  ========================================= */
const { env } = require("../config/env.cjs");

function adminKey(req, res, next) {
  const k = req.headers["x-admin-key"];
  if (!k || k !== env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "admin unauthorized" });
  }
  return next();
}

module.exports = { adminKey };