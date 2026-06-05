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
const { sendInternalError } = require("../utils/errorResponse.cjs");

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

function normalizeVersionCode(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

function normalizeAppVersionPayload(body) {
  const direct = normStr(
    body?.app_version ??
      body?.appVersion ??
      body?.current_app_build,
    32
  );
  if (direct) return direct;

  const versionName = normStr(
    body?.version_name ??
      body?.versionName ??
      body?.version,
    24
  );
  const versionCode = normalizeVersionCode(
    body?.version_code ??
      body?.versionCode ??
      body?.build_number ??
      body?.buildNumber
  );

  if (versionName && versionCode) {
    return normStr(`${versionName}+${versionCode}`, 32) || null;
  }

  return versionName || null;
}

function isTrialExpired(trialExpiresAt) {
  if (!trialExpiresAt) return false;
  const expiresAtMs = new Date(trialExpiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs <= Date.now();
}

async function normalizeTrialStatus(device) {
  if (!device) {
    return {
      status: null,
      trial_expires_at: null,
      trial_expired: false,
    };
  }

  const trial_expires_at = device.trial_expires_at || null;
  const trial_expired = isTrialExpired(trial_expires_at);
  let status = device.status || null;

  if (trial_expired && status !== "suspended" && device.id) {
    await pool.execute(
      `UPDATE devices
       SET status='suspended', updated_at=NOW()
       WHERE id=?`,
      [device.id]
    );
    status = "suspended";
  }

  return {
    status,
    trial_expires_at,
    trial_expired,
  };
}

function normalizeWhmcsPrice(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const numeric = Number(raw.replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return raw;
  return numeric.toFixed(2);
}

function extractWhmcsPrice(product) {
  if (!product || typeof product !== "object") return null;
  const candidates = [
    product.recurringamount,
    product.recurring_amount,
    product.amount,
    product.price,
    product.total,
    product.firstpaymentamount,
    product.first_payment_amount,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhmcsPrice(candidate);
    if (normalized) return normalized;
  }
  return null;
}

async function fetchWhmcsPriceByServiceId(serviceId) {
  const serviceIdNum = Number(serviceId || 0);
  if (!Number.isFinite(serviceIdNum) || serviceIdNum <= 0) return null;

  const apiUrl = String(env.WHMCS_API_URL || "").trim();
  const identifier = String(env.WHMCS_API_IDENTIFIER || "").trim();
  const secret = String(env.WHMCS_API_SECRET || "").trim();

  if (!apiUrl || !identifier || !secret) return null;

  try {
    const body = new URLSearchParams({
      action: "GetClientsProducts",
      serviceid: String(serviceIdNum),
      identifier,
      secret,
      responsetype: "json",
    });

    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "streamin-api/1.0",
      },
      body: body.toString(),
    });

    const text = await resp.text();
    if (!resp.ok) return null;

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }

    if (String(data?.result || "").toLowerCase() !== "success") return null;

    let products = data?.products?.product || [];
    if (!Array.isArray(products)) {
      products = products && typeof products === "object" ? [products] : [];
    }

    const matched =
      products.find((p) => Number(p?.id || p?.serviceid || 0) === serviceIdNum) ||
      products[0] ||
      null;
    if (!matched) return null;

    return extractWhmcsPrice(matched);
  } catch {
    return null;
  }
}

function logRegisterDebug(event, details) {
  if (!env.API_DEBUG_ERRORS) return;
  console.warn("[device/register]", event, details);
}

function buildPostUpdateNotification(currentAppVersion) {
  const version = normStr(currentAppVersion, 32);
  return {
    title: "App has been updated",
    message: version
      ? `StreamIN has been updated to version ${version}.`
      : "App has been updated.",
  };
}

function compareVersionStrings(left, right) {
  const leftParts = String(left || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => Number(value));
  const rightParts = String(right || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => Number(value));

  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const b = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (a !== b) return a > b ? 1 : -1;
  }

  return 0;
}

async function createPostUpdateNotificationIfNeeded({
  deviceId,
  previousAppVersion,
  currentAppVersion,
  status,
}) {
  const targetDeviceId = Number(deviceId || 0);
  if (!Number.isFinite(targetDeviceId) || targetDeviceId <= 0) {
    return { created: false, reason: "invalid_device_id" };
  }

  const currentStatus = String(status || "").trim().toLowerCase();
  if (currentStatus && currentStatus !== "active") {
    return { created: false, reason: "device_not_active" };
  }

  const previousVersion = normStr(previousAppVersion, 32);
  const nextVersion = normStr(currentAppVersion, 32);
  if (!previousVersion) {
    return { created: false, reason: "no_previous_version" };
  }
  if (!nextVersion) {
    return { created: false, reason: "no_current_version" };
  }
  if (compareVersionStrings(nextVersion, previousVersion) <= 0) {
    return { created: false, reason: "not_newer_version" };
  }

  const content = buildPostUpdateNotification(nextVersion);

  try {
    const [existingRows] = await pool.execute(
      `
      SELECT id
      FROM app_notifications
      WHERE COALESCE(target_scope, 'mass')='device'
        AND target_device_id=?
        AND title=?
        AND message=?
      LIMIT 1
      `,
      [targetDeviceId, content.title, content.message]
    );

    if (existingRows[0]) {
      return {
        created: false,
        reason: "already_created",
        notification_id: Number(existingRows[0].id),
      };
    }

    const [ins] = await pool.execute(
      `
      INSERT INTO app_notifications
        (title, message, status, target_scope, target_platform, target_device_id, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
      VALUES
        (?, ?, 'active', 'device', 'all', ?, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), NULL, NOW(), NOW())
      `,
      [content.title, content.message, targetDeviceId]
    );

    return {
      created: true,
      notification_id: Number(ins?.insertId || 0) || null,
    };
  } catch (err) {
    console.warn("[device/register] post-update notification failed", {
      code: err?.code,
      message: err?.message,
      deviceId: targetDeviceId,
      previousVersion,
      nextVersion,
    });
    return { created: false, reason: "notification_failed" };
  }
}

/** =========================================
 *  POST /v1/device/register
 *  body: { device_uuid, platform, model, app_version }
 *  ========================================= */
router.post("/device/register", async (req, res) => {
  try {
    const device_uuid = normStr(
      req.body?.device_uuid ?? req.body?.device_id ?? req.body?.device_fingerprint,
      64
    );
    const legacy_device_uuid = normStr(
      req.body?.legacy_device_uuid ?? req.body?.previous_device_uuid,
      64
    );
    const platform = normStr(req.body?.platform, 32) || null;
    const model = normStr(req.body?.model, 80) || null;
    const app_version = normalizeAppVersionPayload(req.body);

    if (!device_uuid) {
      return res.status(400).json({ error: "device_uuid, device_id, or device_fingerprint required" });
    }
    if (!isUuidLike(device_uuid)) return res.status(400).json({ error: "invalid device_uuid" });

    logRegisterDebug("request", {
      device_uuid,
      legacy_device_uuid: legacy_device_uuid || null,
      platform,
      model,
      app_version,
    });

    // Existing?
    const [exRows] = await pool.execute(
      `SELECT id, device_code, status, trial_expires_at, plan_name, whmcs_account_number, whmcs_service_id, app_version
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

      const trialState = await normalizeTrialStatus(exRows[0]);
      const whmcsPrice =
        trialState.status === "suspended"
          ? await fetchWhmcsPriceByServiceId(exRows[0].whmcs_service_id)
          : null;
      await createPostUpdateNotificationIfNeeded({
        deviceId: exRows[0].id,
        previousAppVersion: exRows[0].app_version,
        currentAppVersion: app_version,
        status: trialState.status,
      });
      logRegisterDebug("existing-device", {
        branch: "device_uuid",
        device_uuid,
        device_id: exRows[0].id,
      });

      return res.json({
        device_code: exRows[0].device_code,
        status: trialState.status,
        trial_expires_at: trialState.trial_expires_at,
        trial_expired: trialState.trial_expired,
        plan_name: exRows[0].plan_name || null,
        plan: exRows[0].plan_name || null,
        whmcs_account_number: exRows[0].whmcs_account_number || null,
        whmcsAccountNumber: exRows[0].whmcs_account_number || null,
        account_number: exRows[0].whmcs_account_number || null,
        accountNumber: exRows[0].whmcs_account_number || null,
        whmcs_price: whmcsPrice,
        whmcsPrice: whmcsPrice,
        price: whmcsPrice,
        whmcs: {
          account_number: exRows[0].whmcs_account_number || null,
          accountNumber: exRows[0].whmcs_account_number || null,
          price: whmcsPrice,
        },
      });
    }

    if (legacy_device_uuid && legacy_device_uuid !== device_uuid) {
      const [legacyRows] = await pool.execute(
        `SELECT id, device_code, status, trial_expires_at, plan_name, whmcs_account_number, whmcs_service_id, app_version
         FROM devices
         WHERE device_uuid=?
         LIMIT 1`,
        [legacy_device_uuid]
      );

      if (legacyRows[0]) {
        await pool.execute(
          `UPDATE devices
           SET device_uuid=?, last_seen_at=NOW(), updated_at=NOW(),
               platform=COALESCE(?, platform),
               model=COALESCE(?, model),
               app_version=COALESCE(?, app_version)
           WHERE id=?`,
          [device_uuid, platform, model, app_version, legacyRows[0].id]
        );

        const trialState = await normalizeTrialStatus(legacyRows[0]);
        const whmcsPrice =
          trialState.status === "suspended"
            ? await fetchWhmcsPriceByServiceId(legacyRows[0].whmcs_service_id)
            : null;
        await createPostUpdateNotificationIfNeeded({
          deviceId: legacyRows[0].id,
          previousAppVersion: legacyRows[0].app_version,
          currentAppVersion: app_version,
          status: trialState.status,
        });
        logRegisterDebug("legacy-device", {
          branch: "legacy_device_uuid",
          device_uuid,
          legacy_device_uuid,
          device_id: legacyRows[0].id,
        });

        return res.json({
          device_code: legacyRows[0].device_code,
          status: trialState.status,
          trial_expires_at: trialState.trial_expires_at,
          trial_expired: trialState.trial_expired,
          plan_name: legacyRows[0].plan_name || null,
          plan: legacyRows[0].plan_name || null,
          whmcs_account_number: legacyRows[0].whmcs_account_number || null,
          whmcsAccountNumber: legacyRows[0].whmcs_account_number || null,
          account_number: legacyRows[0].whmcs_account_number || null,
          accountNumber: legacyRows[0].whmcs_account_number || null,
          whmcs_price: whmcsPrice,
          whmcsPrice: whmcsPrice,
          price: whmcsPrice,
          whmcs: {
            account_number: legacyRows[0].whmcs_account_number || null,
            accountNumber: legacyRows[0].whmcs_account_number || null,
            price: whmcsPrice,
          },
        });
      }
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

    logRegisterDebug("new-device", {
      branch: "insert",
      device_uuid,
      legacy_device_uuid: legacy_device_uuid || null,
      device_id: deviceId,
    });

    return res.json({
      device_code: code,
      status: "pending",
      trial_expires_at: null,
      trial_expired: false,
      plan_name: null,
      plan: null,
      whmcs_account_number: null,
      whmcsAccountNumber: null,
      account_number: null,
      accountNumber: null,
      whmcs_price: null,
      whmcsPrice: null,
      price: null,
    });
  } catch (err) {
    return sendInternalError(req, res, "device/register", err);
  }
});

/** =========================================
 *  POST /v1/device/auth
 *  body: { device_uuid, device_code, model?, app_version? }
 *  ========================================= */
router.post("/device/auth", async (req, res) => {
  try {
    const device_uuid = normStr(
      req.body?.device_uuid ?? req.body?.device_id ?? req.body?.device_fingerprint,
      64
    );
    const device_code = normStr(req.body?.device_code, 32);
    const model = normStr(req.body?.model, 80) || null;
    const app_version = normalizeAppVersionPayload(req.body);

    if (!device_uuid || !device_code) {
      return res.status(400).json({ error: "device_uuid + device_code required" });
    }
    if (!isUuidLike(device_uuid)) return res.status(400).json({ error: "invalid device_uuid" });

    const [rows] = await pool.execute(
      `SELECT
         d.id,
         d.device_uuid,
         d.status,
         d.trial_expires_at,
         d.plan_name,
         d.whmcs_account_number,
         d.whmcs_service_id,
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

    const trialState = await normalizeTrialStatus(dev);
    if (trialState.status !== "active") {
      const whmcsPrice =
        trialState.status === "suspended"
          ? await fetchWhmcsPriceByServiceId(dev.whmcs_service_id)
          : null;
      return res.status(403).json({
        error: trialState.trial_expired ? "trial expired" : "device not active",
        status: trialState.status,
        trial_expires_at: trialState.trial_expires_at,
        trial_expired: trialState.trial_expired,
        plan_name: dev.plan_name || null,
        plan: dev.plan_name || null,
        whmcs_account_number: dev.whmcs_account_number || null,
        whmcsAccountNumber: dev.whmcs_account_number || null,
        account_number: dev.whmcs_account_number || null,
        accountNumber: dev.whmcs_account_number || null,
        whmcs_price: whmcsPrice,
        whmcsPrice: whmcsPrice,
        price: whmcsPrice,
        whmcs: {
          account_number: dev.whmcs_account_number || null,
          accountNumber: dev.whmcs_account_number || null,
          price: whmcsPrice,
        },
      });
    }

    if (dev.expires_at) {
      const exp = new Date(dev.expires_at).getTime();
      if (!Number.isNaN(exp) && exp < Date.now()) {
        return res.status(403).json({
          error: "device expired",
          status: trialState.status,
          trial_expires_at: trialState.trial_expires_at,
          trial_expired: trialState.trial_expired,
        });
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
       SET last_seen_at=NOW(), updated_at=NOW(),
           model=COALESCE(?, model),
           app_version=COALESCE(?, app_version)
       WHERE id=?`,
      [model, app_version, dev.id]
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
    return sendInternalError(req, res, "device/auth", err);
  }
});

/** =========================================
 *  POST /v1/device/heartbeat
 *  - lightweight presence ping for active devices
 *  ========================================= */
router.post("/device/heartbeat", authJwt, async (req, res) => {
  try {
    const deviceId = Number(req.device?.device_id || 0);
    const model = normStr(req.body?.model, 80) || null;
    const app_version = normalizeAppVersionPayload(req.body);
    if (!Number.isFinite(deviceId) || deviceId <= 0) {
      return res.status(401).json({ error: "device not found" });
    }

    await pool.execute(
      `UPDATE devices
       SET last_seen_at=NOW(),
           updated_at=NOW(),
           model=COALESCE(?, model),
           app_version=COALESCE(?, app_version)
       WHERE id=?`,
      [model, app_version, deviceId]
    );

    return res.json({
      ok: true,
      online_window_seconds: Number(env.DEVICE_ONLINE_WINDOW_SECONDS || 8),
    });
  } catch (err) {
    return sendInternalError(req, res, "device/heartbeat", err);
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
    return sendInternalError(req, res, "device/adult/verify", err);
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
    return sendInternalError(req, res, "device/adult/set", err);
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
    return sendInternalError(req, res, "device/adult/reset", err);
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
    return sendInternalError(req, res, "device/adult/status", err);
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
        d.id,
        d.status,
        d.device_code,
        d.customer_name,
        d.plan_name,
        d.trial_expires_at,
        d.whmcs_account_number,
        d.whmcs_service_id,
        d.whmcs_next_due_date,
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
    const trialState = await normalizeTrialStatus(device);
    const whmcsPrice =
      trialState.status === "suspended"
        ? await fetchWhmcsPriceByServiceId(device.whmcs_service_id)
        : null;
    let playlistUrl = "";
    try {
      const [playlistRows] = await pool.execute(
        `SELECT playlist_url FROM device_playlist WHERE device_id=? LIMIT 1`,
        [device.id]
      );
      playlistUrl = String(playlistRows[0]?.playlist_url || "").trim();
    } catch (err) {
      if (String(err?.code || "") !== "ER_NO_SUCH_TABLE") throw err;
    }

    return res.json({
      status: trialState.status,
      device_code: device.device_code || req.device.device_code || null,
      customer_name: device.customer_name || null,
      plan_name: device.plan_name || null,
      plan: device.plan_name || null,
      trial_expires_at: trialState.trial_expires_at,
      trial_expired: trialState.trial_expired,
      whmcs_account_number: device.whmcs_account_number || null,
      whmcsAccountNumber: device.whmcs_account_number || null,
      account_number: device.whmcs_account_number || null,
      accountNumber: device.whmcs_account_number || null,
      companyname: device.whmcs_account_number || null,
      company_name: device.whmcs_account_number || null,
      whmcs_price: whmcsPrice,
      whmcsPrice: whmcsPrice,
      price: whmcsPrice,
      whmcs_next_due_date: device.whmcs_next_due_date || null,
      whmcsNextDueDate: device.whmcs_next_due_date || null,
      next_due_date: device.whmcs_next_due_date || null,
      nextDueDate: device.whmcs_next_due_date || null,
      playlist_url: playlistUrl || null,
      playlistUrl: playlistUrl || null,
      custom_playlist_url: playlistUrl || null,
      customPlaylistUrl: playlistUrl || null,
      whmcs: {
        account_number: device.whmcs_account_number || null,
        accountNumber: device.whmcs_account_number || null,
        companyname: device.whmcs_account_number || null,
        company_name: device.whmcs_account_number || null,
        price: whmcsPrice,
        next_due_date: device.whmcs_next_due_date || null,
        nextDueDate: device.whmcs_next_due_date || null,
      },
      expires_at: device.expires_at || null,
      max_streams: Number(device.max_streams || 1),
    });
  } catch (err) {
    return sendInternalError(req, res, "device/profile", err);
  }
});

module.exports = router;
