/** =========================================
 *  MIDDLEWARE: Admin Auth (CommonJS)
 *  - Requires x-admin-key
 *  - Optionally loads admin by x-admin-id for role scoping
 *  ========================================= */
const { env } = require("../config/env.cjs");
const { pool } = require("../db/pool.cjs");

async function adminAuth(req, res, next) {
  try {
    const k = req.headers["x-admin-key"];
    if (!k || k !== env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "admin unauthorized" });
    }

    const idHeader = String(req.headers["x-admin-id"] || "").trim();
    if (!idHeader) {
      req.admin = { id: null, role: "super_admin", name: null, auth: "key" };
      return next();
    }

    const adminId = Number(idHeader);
    if (!Number.isFinite(adminId) || adminId <= 0) {
      return res.status(400).json({ error: "invalid admin id" });
    }

    const [rows] = await pool.execute(
      `SELECT id, name, email, username, role, status
       FROM admins
       WHERE id=?
       LIMIT 1`,
      [adminId]
    );

    const admin = rows[0];
    if (!admin) return res.status(403).json({ error: "admin not found" });
    if (String(admin.status || "").toLowerCase() !== "active") {
      return res.status(403).json({ error: "admin disabled" });
    }

    req.admin = admin;
    return next();
  } catch (err) {
    console.error("[adminAuth] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
}

module.exports = { adminAuth };
