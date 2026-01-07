/** =========================================
 *  MIDDLEWARE: Device JWT (CommonJS)
 *  Authorization: Bearer <token>
 *  ========================================= */
const jwt = require("jsonwebtoken");
const { env } = require("../config/env.cjs");

function authJwt(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "missing token" });
  }

  try {
    req.device = jwt.verify(token, env.JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "invalid token" });
  }
}

module.exports = { authJwt };