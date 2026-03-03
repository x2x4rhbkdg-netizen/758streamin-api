const { Router } = require("express");
const { pool } = require("../db/pool.cjs");
const { authJwt } = require("../middleware/authJwt.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

function toInt(v, fallback = 30) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function normPlatform(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  return s.length > 32 ? s.slice(0, 32) : s;
}

function derivePlatformAlias(platform) {
  const p = normPlatform(platform);
  if (!p) return "";
  if (p.startsWith("android")) return "android";
  if (p.startsWith("ios")) return "ios";
  return "";
}

function toIsoUtcDateTime(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return raw.replace(" ", "T") + "Z";
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString();
}

function normalizeNotificationTimestamps(row) {
  if (!row || typeof row !== "object") return row;
  return {
    ...row,
    starts_at: toIsoUtcDateTime(row.starts_at),
    ends_at: toIsoUtcDateTime(row.ends_at),
    created_at: toIsoUtcDateTime(row.created_at),
    updated_at: toIsoUtcDateTime(row.updated_at),
  };
}

function normalizeMergeValue(value, formatter) {
  if (value === null || typeof value === "undefined") return "";
  const raw = typeof formatter === "function" ? formatter(value) : value;
  if (raw === null || typeof raw === "undefined") return "";
  const str = String(raw).trim();
  return str;
}

function toLocalDateText(value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const d = new Date(isoCandidate);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function buildMergeMap(device) {
  return {
    "{{device_code}}": normalizeMergeValue(device?.device_code),
    "{{customer_name}}": normalizeMergeValue(device?.customer_name),
    "{{customer_phone}}": normalizeMergeValue(device?.customer_phone),
    "{{plan_name}}": normalizeMergeValue(device?.plan_name),
    "{{trial_expires_at}}": normalizeMergeValue(device?.trial_expires_at, toLocalDateText),
    "{{whmcs_next_due_date}}": normalizeMergeValue(device?.whmcs_next_due_date, toLocalDateText),
    "{{whmcs_account_number}}": normalizeMergeValue(device?.whmcs_account_number),
  };
}

function applyMergeTags(value, mergeMap) {
  if (value === null || typeof value === "undefined") return value;
  let output = String(value);
  for (const [tag, replacement] of Object.entries(mergeMap || {})) {
    output = output.split(tag).join(replacement);
  }
  return output;
}

function personalizeNotification(row, mergeMap) {
  if (!row || typeof row !== "object") return row;
  return {
    ...row,
    title: applyMergeTags(row.title, mergeMap),
    message: applyMergeTags(row.message, mergeMap),
    ticker_text: applyMergeTags(row.ticker_text, mergeMap),
  };
}

router.get("/notifications", authJwt, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, toInt(req.query.limit, 50)));
    const deviceId = Number(req.device.device_id);

    const [deviceRows] = await pool.execute(
      `
      SELECT
        platform,
        device_code,
        customer_name,
        customer_phone,
        plan_name,
        trial_expires_at,
        whmcs_next_due_date,
        whmcs_account_number
      FROM devices
      WHERE id=?
      LIMIT 1
      `,
      [deviceId]
    );
    const deviceRow = deviceRows[0] || null;

    let platform = normPlatform(req.query.platform);
    if (!platform) {
      platform = normPlatform(deviceRow?.platform || "");
    }

    const alias = derivePlatformAlias(platform);
    const mergeMap = buildMergeMap(deviceRow);

    const params = [deviceId];
    let massPlatformClause = "";

    if (platform) {
      massPlatformClause = `\n              AND (n.target_platform='all' OR n.target_platform=?`;
      params.push(platform);
      if (alias && alias !== platform) {
        massPlatformClause += ` OR n.target_platform=?`;
        params.push(alias);
      }
      massPlatformClause += `)`;
    } else {
      massPlatformClause = `\n              AND n.target_platform='all'`;
    }

    const [rows] = await pool.execute(
      `
      SELECT
        n.id,
        n.title,
        n.message,
        n.image_url,
        n.is_ticker,
        n.ticker_text,
        n.target_scope,
        n.target_platform,
        DATE_FORMAT(n.starts_at, "%Y-%m-%d %H:%i:%s") AS starts_at,
        DATE_FORMAT(n.ends_at, "%Y-%m-%d %H:%i:%s") AS ends_at,
        n.created_at,
        n.updated_at
      FROM app_notifications n
      WHERE n.status='active'
        AND (n.starts_at IS NULL OR n.starts_at <= UTC_TIMESTAMP())
        AND (n.ends_at IS NULL OR n.ends_at >= UTC_TIMESTAMP())
        AND (
          (COALESCE(n.target_scope, 'mass')='device' AND n.target_device_id=?)
          OR
          (
            COALESCE(n.target_scope, 'mass')='mass'
            ${massPlatformClause}
          )
        )
      ORDER BY COALESCE(n.starts_at, n.created_at) DESC, n.id DESC
      LIMIT ${limit}
      `,
      params
    );

    return res.json({
      notifications: rows.map((row) =>
        normalizeNotificationTimestamps(personalizeNotification(row, mergeMap))
      ),
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ notifications: [], server_time: new Date().toISOString() });
    }
    return sendInternalError(req, res, "notifications/list", err);
  }
});

module.exports = router;
