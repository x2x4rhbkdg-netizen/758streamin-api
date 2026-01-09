/** =========================================
 *  ROUTES: Device register/auth (CommonJS) - MySQL
 *  - Uses mysql2/promise pool
 *  - Safer UUID/code handling + unique-code retry
 *  - Normalizes inputs
 *  ========================================= */
const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool.cjs");
const { makeDeviceCode } = require("../utils/deviceCode.cjs");
const { env } = require("../config/env.cjs");

const router = Router();

/** =========================================
 *  HELPERS
 *  ========================================= */
function normStr(v, max = 120) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function isUuidLike(v) {
  // Accept strict UUID, but keep it permissive enough for platform UUID formats
  // If you want strict only, use: /^[0-9a-f]{8}-...$/i
  return typeof v === "string" && v.trim().length >= 8 && v.trim().length <= 64;
}

/** =========================================
 *  POST /v1/device/register
 *  body: { device_uuid, platform, model, app_version }
 *  ========================================= */
router.post("/device/register", async (req, res) => {
  try {
    const device_uuid = normStr(req.body?.device_uuid ?? req.body?.device_id, 64);
    const platform = normStr(req.body?.platform, 32) || null;
    const model = normStr(req.body?.model, 80) || null;
    const app_version = normStr(req.body?.app_version, 32) || null;

    if (!device_uuid) return res.status(400).json({ error: "device_uuid or device_id required" });
    if (!isUuidLike(device_uuid)) return res.status(400).json({ error: "invalid device_uuid" });

    // Existing?
    const [exRows] = await pool.execute(
      `SELECT id, device_code, status
       FROM devices
       WHERE device_uuid=?
       LIMIT 1`,
      [device_uuid]
    );

    if (exRows[0]) {
      await pool.execute(
        `UPDATE devices
         SET last_seen_at=NOW(), updated_at=NOW(),
             platform=COALESCE(?, platform),
             model=COALESCE(?, model),
             app_version=COALESCE(?, app_version)
         WHERE id=?`,
        [platform, model, app_version, exRows[0].id]
      );

      return res.json({
        device_code: exRows[0].device_code,
        status: exRows[0].status,
      });
    }

    // Create new pending device (device_code uniqueness)
    // Prefer relying on UNIQUE index + retry on duplicate rather than pre-check loops.
    let code = "";
    let deviceId = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      code = makeDeviceCode();

      try {
        const [insResult] = await pool.execute(
          `INSERT INTO devices
            (device_uuid, device_code, status, platform, model, app_version, last_seen_at, created_at, updated_at)
           VALUES
            (?, ?, 'pending', ?, ?, ?, NOW(), NOW(), NOW())`,
          [device_uuid, code, platform, model, app_version]
        );

        deviceId = insResult.insertId;
        break;
      } catch (e) {
        // ER_DUP_ENTRY = 1062
        if (e && e.code === "ER_DUP_ENTRY") continue;
        throw e;
      }
    }

    if (!deviceId) {
      return res.status(500).json({ error: "device_code collision" });
    }

    // Default access row (device_id is PRIMARY KEY in device_access)
    await pool.execute(
      `INSERT INTO device_access (device_id, max_streams, updated_at)
       VALUES (?, 1, NOW())
       ON DUPLICATE KEY UPDATE updated_at=NOW()`,
      [deviceId]
    );

    return res.json({ device_code: code, status: "pending" });
  } catch (err) {
    console.error("[device/register] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  POST /v1/device/auth
 *  body: { device_uuid, device_code }
 *  ========================================= */
router.post("/device/auth", async (req, res) => {
  try {
    const device_uuid = normStr(req.body?.device_uuid ?? req.body?.device_id, 64);
    const device_code = normStr(req.body?.device_code, 32);

    if (!device_uuid || !device_code) {
      return res.status(400).json({ error: "device_uuid + device_code required" });
    }

    const [rows] = await pool.execute(
      `SELECT
         d.id,
         d.status,
         a.expires_at,
         a.max_streams
       FROM devices d
       LEFT JOIN device_access a ON a.device_id = d.id
       WHERE d.device_uuid=? AND d.device_code=?
       LIMIT 1`,
      [device_uuid, device_code]
    );

    const dev = rows[0];
    if (!dev) return res.status(401).json({ error: "device not registered" });
    if (dev.status !== "active") return res.status(403).json({ error: "device not active" });

    if (dev.expires_at) {
      const exp = new Date(dev.expires_at).getTime();
      if (!Number.isNaN(exp) && exp < Date.now()) {
        return res.status(403).json({ error: "device expired" });
      }
    }

    await pool.execute(
      `UPDATE devices
       SET last_seen_at=NOW(), updated_at=NOW()
       WHERE id=?`,
      [dev.id]
    );

    const token = jwt.sign(
      {
        device_id: dev.id,
        device_code,
        max_streams: Number(dev.max_streams || 1),
      },
      env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      access_token: token,
      max_streams: Number(dev.max_streams || 1),
      expires_at: dev.expires_at || null,
    });
  } catch (err) {
    console.error("[device/auth] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;