/** =========================================
 *  MIDDLEWARE: Device JWT (CommonJS)
 *  Authorization: Bearer <token>
 *  ========================================= */
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool.cjs");
const { env } = require("../config/env.cjs");

async function authJwt(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "missing token" });
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);

    const deviceId = payload?.device_id;
    if (!deviceId) {
      return res.status(401).json({ error: "invalid token" });
    }

    const [rows] = await pool.execute(
      `SELECT d.status, a.expires_at, a.max_streams
       FROM devices d
       LEFT JOIN device_access a ON a.device_id = d.id
       WHERE d.id=?
       LIMIT 1`,
      [deviceId]
    );

    const dev = rows[0];
    if (!dev) return res.status(401).json({ error: "device not found" });
    if (dev.status !== "active") return res.status(403).json({ error: "device not active" });

    if (dev.expires_at) {
      const exp = new Date(dev.expires_at).getTime();
      if (!Number.isNaN(exp) && exp < Date.now()) {
        return res.status(403).json({ error: "device expired" });
      }
    }

    req.device = {
      ...payload,
      max_streams: Number(dev.max_streams || payload.max_streams || 1),
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "invalid token" });
  }
}

module.exports = { authJwt };
