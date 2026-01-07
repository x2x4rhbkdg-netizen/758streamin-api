/** =========================================
 *  ROUTES: Admin (x-admin-key required) (CommonJS)
 *  - MySQL (mysql2/promise)
 *  - Case-insensitive search (safe across collations)
 *  - MySQL-safe datetime handling
 *  ========================================= */
const { Router } = require("express");
const { adminKey } = require("../middleware/adminKey.cjs");
const { pool } = require("../db/pool.cjs");
const { encryptString } = require("../utils/cryptoVault.cjs");

const router = Router();
router.use(adminKey);

/** =========================================
 *  HELPERS: Datetime
 *  - Converts ISO/Date-ish input to MySQL DATETIME "YYYY-MM-DD HH:MM:SS"
 *  - Returns null if invalid/empty
 *  ========================================= */
function toMysqlDatetime(v) {
  if (!v) return null;

  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** =========================================
 *  HELPERS: Normalize URL (trim trailing slashes)
 *  ========================================= */
function normalizeBaseUrl(v) {
  return String(v || "").trim().replace(/\/+$/, "");
}

/** =========================================
 *  GET /v1/admin/devices?search=
 *  - Lists recent devices + access info
 *  - Search is case-insensitive regardless of collation
 *  ========================================= */
router.get("/devices", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    let where = "";
    const params = [];

    if (search) {
      const s = `%${search}%`;
      where = `
        WHERE
          LOWER(d.device_code) LIKE LOWER(?) OR
          LOWER(COALESCE(d.platform,'')) LIKE LOWER(?) OR
          LOWER(COALESCE(d.model,'')) LIKE LOWER(?)
      `;
      params.push(s, s, s);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        d.device_code,
        d.status,
        d.platform,
        d.model,
        d.app_version,
        d.last_seen_at,
        d.created_at,
        d.updated_at,
        a.expires_at,
        a.max_streams
      FROM devices d
      LEFT JOIN device_access a ON a.device_id = d.id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT 200
      `,
      params
    );

    return res.json({ devices: rows });
  } catch (err) {
    console.error("[admin/devices] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/activate
 *  body: { expires_at, max_streams }
 *  - sets device active
 *  - upserts device_access
 *  ========================================= */
router.post("/devices/:code/activate", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const { expires_at, max_streams } = req.body || {};

    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });

    await pool.execute(
      `UPDATE devices SET status='active', updated_at=NOW() WHERE id=?`,
      [dev.id]
    );

    const exp = toMysqlDatetime(expires_at);
    const ms = Number(max_streams || 1);

    await pool.execute(
      `
      INSERT INTO device_access (device_id, expires_at, max_streams, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        expires_at=VALUES(expires_at),
        max_streams=VALUES(max_streams),
        updated_at=NOW()
      `,
      [dev.id, exp, ms]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/activate] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/suspend
 *  - sets device suspended
 *  ========================================= */
router.post("/devices/:code/suspend", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [result] = await pool.execute(
      `UPDATE devices SET status='suspended', updated_at=NOW() WHERE device_code=?`,
      [code]
    );

    if (!result.affectedRows) return res.status(404).json({ error: "device not found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/suspend] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/upstream
 *  body: { upstream_base_url, username, password }
 *  - stores encrypted upstream creds per device
 *  ========================================= */
router.post("/devices/:code/upstream", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const { upstream_base_url, username, password } = req.body || {};

    if (!code) return res.status(400).json({ error: "device code required" });
    if (!upstream_base_url || !username || !password) {
      return res.status(400).json({ error: "upstream_base_url + username + password required" });
    }

    const base = normalizeBaseUrl(upstream_base_url);
    if (!base) return res.status(400).json({ error: "invalid upstream_base_url" });

    const [devRows] = await pool.execute(
      `SELECT id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });

    const encU = encryptString(username);
    const encP = encryptString(password);

    await pool.execute(
      `
      INSERT INTO device_upstream (device_id, upstream_base_url, enc_username, enc_password, updated_at)
      VALUES (?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        upstream_base_url=VALUES(upstream_base_url),
        enc_username=VALUES(enc_username),
        enc_password=VALUES(enc_password),
        updated_at=NOW()
      `,
      [dev.id, base, encU, encP]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/upstream] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;