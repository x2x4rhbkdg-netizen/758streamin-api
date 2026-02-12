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
const { authJwt } = require("../middleware/authJwt.cjs");
const { decryptString, encryptString } = require("../utils/cryptoVault.cjs");
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

function normalizePin(pin) {
  const s = String(pin || "").trim();
  return /^\d{4}$/.test(s) ? s : null;
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
    if (!isUuidLike(device_uuid)) return res.status(400).json({ error: "invalid device_uuid" });

    const [rows] = await pool.execute(
      `SELECT
         d.id,
         d.device_uuid,
         d.status,
         a.expires_at,
         a.max_streams
       FROM devices d
       LEFT JOIN device_access a ON a.device_id = d.id
       WHERE d.device_code=?
       LIMIT 1`,
      [device_code]
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

    if (String(dev.device_uuid) !== String(device_uuid)) {
      const [uuidRows] = await pool.execute(
        `SELECT id, status FROM devices WHERE device_uuid=? LIMIT 1`,
        [device_uuid]
      );

      const uuidDev = uuidRows[0];
      if (uuidDev && Number(uuidDev.id) !== Number(dev.id)) {
        if (uuidDev.status === "pending") {
          await pool.execute(`DELETE FROM devices WHERE id=?`, [uuidDev.id]);
        } else {
          return res.status(409).json({ error: "device already active" });
        }
      }

      await pool.execute(
        `UPDATE devices
         SET device_uuid=?, updated_at=NOW()
         WHERE id=?`,
        [device_uuid, dev.id]
      );
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

/** =========================================
 *  POST /v1/device/adult/verify
 *  body: { pin }
 *  - verifies per-device adult PIN (encrypted in device_access)
 *  ========================================= */
router.post("/device/adult/verify", authJwt, async (req, res) => {
  try {
    const pin = normalizePin(req.body?.pin);
    if (!pin) {
      return res.status(400).json({ error: "pin must be 4 digits" });
    }

    const deviceId = req.device.device_id;
    const [rows] = await pool.execute(
      `SELECT adult_pin_enc FROM device_access WHERE device_id=? LIMIT 1`,
      [deviceId]
    );

    const encPin = rows[0]?.adult_pin_enc;
    if (!encPin) return res.status(404).json({ error: "pin not set" });

    const stored = decryptString(encPin);
    if (stored !== pin) {
      return res.status(403).json({ error: "invalid pin" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[device/adult/verify] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  POST /v1/device/adult/set
 *  body: { pin }
 *  - sets adult PIN for this device
 *  ========================================= */
router.post("/device/adult/set", authJwt, async (req, res) => {
  try {
    const pin = normalizePin(req.body?.pin);
    if (!pin) {
      return res.status(400).json({ error: "pin must be 4 digits" });
    }

    const deviceId = req.device.device_id;
    const encPin = encryptString(pin);

    await pool.execute(
      `
      INSERT INTO device_access (device_id, adult_pin_enc, updated_at)
      VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        adult_pin_enc=VALUES(adult_pin_enc),
        updated_at=NOW()
      `,
      [deviceId, encPin]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[device/adult/set] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  DELETE /v1/device/adult/reset
 *  - clears adult PIN for this device
 *  ========================================= */
router.delete("/device/adult/reset", authJwt, async (req, res) => {
  try {
    const deviceId = req.device.device_id;
    await pool.execute(
      `UPDATE device_access SET adult_pin_enc=NULL, updated_at=NOW() WHERE device_id=?`,
      [deviceId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[device/adult/reset] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  GET /v1/device/adult/status
 *  - returns whether adult PIN is configured
 *  ========================================= */
router.get("/device/adult/status", authJwt, async (req, res) => {
  try {
    const deviceId = req.device.device_id;
    const [rows] = await pool.execute(
      `SELECT adult_pin_enc FROM device_access WHERE device_id=? LIMIT 1`,
      [deviceId]
    );
    const enabled = Boolean(rows[0]?.adult_pin_enc);
    return res.json({ enabled });
  } catch (err) {
    console.error("[device/adult/status] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  GET /v1/device/profile
 *  - returns basic device profile details for the authenticated device
 *  ========================================= */
router.get("/device/profile", authJwt, async (req, res) => {
  try {
    const deviceId = req.device.device_id;
    const [rows] = await pool.execute(
      `
      SELECT
        d.device_code,
        d.customer_name,
        d.plan_name,
        d.trial_expires_at,
        a.expires_at,
        a.max_streams
      FROM devices d
      LEFT JOIN device_access a ON a.device_id = d.id
      WHERE d.id=?
      LIMIT 1
      `,
      [deviceId]
    );

    const device = rows[0];
    if (!device) return res.status(404).json({ error: "device not found" });

    return res.json({
      device_code: device.device_code || req.device.device_code || null,
      customer_name: device.customer_name || null,
      plan_name: device.plan_name || null,
      trial_expires_at: device.trial_expires_at || null,
      expires_at: device.expires_at || null,
      max_streams: Number(device.max_streams || 1),
    });
  } catch (err) {
    console.error("[device/profile] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
