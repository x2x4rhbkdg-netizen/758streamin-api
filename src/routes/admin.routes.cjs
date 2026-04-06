/** =========================================
 *  ROUTES: Admin (CommonJS)
 *  - MySQL (mysql2/promise)
 *  - Case-insensitive search (safe across collations)
 *  - MySQL-safe datetime handling
 *  ========================================= */
const { Router } = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { adminAuth } = require("../middleware/adminAuth.cjs");
const { decryptString, encryptString } = require("../utils/cryptoVault.cjs");
const { buildXuiPlayerApiUrls, fetchJsonWithFallback } = require("../utils/xui.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");
const { pool } = require("../db/pool.cjs");
const { sendResetEmail } = require("../utils/email.cjs");
const { env } = require("../config/env.cjs");
const whmcsReminderRoutes = require("./admin.whmcsReminders.routes.cjs");
const createWhmcsReminderIfNeeded = whmcsReminderRoutes.createReminderIfNeeded;
const createWhmcsPaymentConfirmationIfNeeded = whmcsReminderRoutes.createPaymentConfirmationIfNeeded;
const createWhmcsTrialReminderIfNeeded = whmcsReminderRoutes.createTrialReminderIfNeeded;
const extractWhmcsPlanName = whmcsReminderRoutes.extractWhmcsPlanName;

const router = Router();

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

function extractWhmcsUpstreamCredentials(rawService) {
  const username = String(
    rawService?.username ||
      rawService?.service_username ||
      rawService?.serviceusername ||
      ""
  ).trim();
  const password = String(
    rawService?.password ||
      rawService?.service_password ||
      rawService?.servicepassword ||
      ""
  ).trim();

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

function requireSuperAdmin(req, res) {
  if (!req.admin || req.admin.role !== "super_admin") {
    res.status(403).json({ error: "super admin required" });
    return false;
  }
  return true;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getResetEmailErrorPayload(err) {
  const code = String(err?.code || "").trim().toUpperCase();
  const responseCode = Number(err?.responseCode || 0);
  const response = String(err?.response || "").toLowerCase();

  if (code === "EMAIL_NOT_CONFIGURED") {
    return {
      status: 500,
      error: "email not configured",
      hint: "Set SMTP_HOST and SMTP_FROM on the API server.",
    };
  }

  if (code === "EAUTH" || responseCode === 534 || responseCode === 535) {
    return {
      status: 500,
      error: "SMTP authentication failed",
      hint: "Check SMTP_USER and SMTP_PASS.",
    };
  }

  if (
    ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ENOTFOUND", "ECONNREFUSED"].includes(code)
  ) {
    return {
      status: 500,
      error: "SMTP connection failed",
      hint: "Check SMTP_HOST, SMTP_PORT, SMTP_SECURE, DNS, and firewall access.",
    };
  }

  if (
    code === "EENVELOPE" ||
    responseCode === 550 ||
    responseCode === 553 ||
    response.includes("sender") ||
    response.includes("from address")
  ) {
    return {
      status: 500,
      error: "SMTP sender rejected",
      hint: "Check SMTP_FROM and make sure that sender address is allowed by the mail server.",
    };
  }

  return null;
}

function normalizePin(pin) {
  const s = String(pin || "").trim();
  return /^\d{4}$/.test(s) ? s : null;
}

async function fetchXuiJson(upstream, action, params = {}) {
  const urls = buildXuiPlayerApiUrls({
    upstream_base_url: upstream.upstream_base_url,
    username: upstream.username,
    password: upstream.password,
  }, { allowHttpFallback: env.XUI_HTTP_FALLBACK });

  const actionParams = {};
  if (action) actionParams.action = action;
  Object.entries(params).forEach(([k, val]) => {
    if (val === undefined || val === null || val === "") return;
    actionParams[k] = val;
  });

  const requestUrls = (urls || []).map((u) => {
    const url = new URL(u);
    Object.entries(actionParams).forEach(([k, val]) => {
      url.searchParams.set(k, String(val));
    });
    return url.toString();
  });

  return fetchJsonWithFallback(
    requestUrls,
    { method: "GET", headers: { "User-Agent": "streamin-api/1.0" } },
    { timeoutMs: env.XUI_REQUEST_TIMEOUT_MS }
  );
}

function normalizeWhmcsStatus(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  return raw.length > 64 ? raw.slice(0, 64) : raw;
}

function toMysqlDateOnly(v) {
  const raw = String(v || "").trim();
  if (!raw || raw === "0000-00-00") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
  return toMysqlDatetime(raw);
}

function isSchemaMismatch(err) {
  return ["ER_BAD_FIELD_ERROR", "ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"].includes(err?.code);
}

async function fetchWhmcsServiceById(serviceId) {
  const apiUrl = String(env.WHMCS_API_URL || "").trim();
  const identifier = String(env.WHMCS_API_IDENTIFIER || "").trim();
  const secret = String(env.WHMCS_API_SECRET || "").trim();

  if (!apiUrl || !identifier || !secret) {
    const err = new Error("WHMCS API not configured");
    err.status = 500;
    throw err;
  }

  const body = new URLSearchParams({
    action: "GetClientsProducts",
    serviceid: String(serviceId),
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
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error("WHMCS returned invalid JSON");
    err.status = 502;
    err.body = text.slice(0, 300);
    throw err;
  }

  if (!resp.ok) {
    const err = new Error("WHMCS request failed");
    err.status = resp.status;
    err.body = text.slice(0, 300);
    throw err;
  }

  if (String(data?.result || "").toLowerCase() !== "success") {
    const err = new Error(data?.message || "WHMCS API error");
    err.status = 502;
    throw err;
  }

  let products = data?.products?.product || [];
  if (!Array.isArray(products)) {
    products = products && typeof products === "object" ? [products] : [];
  }

  const matched =
    products.find((p) => Number(p?.id || p?.serviceid || 0) === Number(serviceId)) ||
    products[0] ||
    null;

  if (!matched) return null;

  return {
    service_id: Number(matched?.id || matched?.serviceid || serviceId) || Number(serviceId),
    client_id: Number(matched?.clientid || 0) || null,
    status: normalizeWhmcsStatus(matched?.status),
    next_due_date: toMysqlDateOnly(matched?.nextduedate),
    raw: matched,
  };
}

async function fetchWhmcsClientProfileById(clientId) {
  const apiUrl = String(env.WHMCS_API_URL || "").trim();
  const identifier = String(env.WHMCS_API_IDENTIFIER || "").trim();
  const secret = String(env.WHMCS_API_SECRET || "").trim();

  if (!apiUrl || !identifier || !secret || !Number(clientId)) {
    return null;
  }

  const body = new URLSearchParams({
    action: "GetClientsDetails",
    clientid: String(Number(clientId)),
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
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!resp.ok || String(data?.result || "").toLowerCase() !== "success") {
    return null;
  }

  const firstName = String(data?.firstname || "").trim();
  const lastName = String(data?.lastname || "").trim();
  const name =
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    String(data?.fullname || data?.clientname || "").trim() ||
    null;
  const accountNumber = String(
    data?.companyname ||
    data?.company_name ||
    ""
  ).trim() || null;
  const phone = String(
    data?.phonenumber ||
    data?.phone ||
    data?.phonenumberformatted ||
    ""
  ).trim();

  if (!name && !phone && !accountNumber) return null;

  return {
    name,
    phone: phone || null,
    accountNumber,
  };
}

async function getAnalyticsUpstreams(admin) {
  const params = [];
  let where = "WHERE du.enc_username IS NOT NULL AND du.enc_password IS NOT NULL";
  if (admin?.role !== "super_admin") {
    where += " AND d.reseller_admin_id=?";
    params.push(admin.id);
  }

  const [rows] = await pool.execute(
    `
    SELECT du.upstream_base_url, du.enc_username, du.enc_password
    FROM device_upstream du
    JOIN devices d ON d.id = du.device_id
    ${where}
    ORDER BY du.updated_at DESC
    LIMIT 50
    `,
    params
  );

  const unique = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const upstreamBaseUrl = row?.upstream_base_url || env.XUI_BASE_URL || "";
    if (!upstreamBaseUrl) continue;

    const username = decryptString(row.enc_username);
    const password = decryptString(row.enc_password);
    if (!username || !password) continue;

    const dedupeKey = `${upstreamBaseUrl}\u0000${username}\u0000${password}`;
    if (unique.has(dedupeKey)) continue;

    unique.set(dedupeKey, {
      upstream_base_url: upstreamBaseUrl,
      username,
      password,
    });
  }

  return Array.from(unique.values());
}

function clampAnalyticsInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeAnalyticsText(value) {
  return String(value || "").trim();
}

function normalizeAnalyticsDeviceCode(value) {
  return normalizeAnalyticsText(value).toUpperCase();
}

function normalizeAnalyticsLookupType(value) {
  const type = normalizeAnalyticsText(value).toLowerCase() || "live";
  if (["stream", "channel", "radio"].includes(type)) return "live";
  if (["movie", "vod", "video"].includes(type)) return "vod";
  if (["show", "season", "episode", "series"].includes(type)) return "series";
  return type;
}

function parseAnalyticsCsvParam(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((part) => normalizeAnalyticsText(part))
        .filter(Boolean)
    )
  );
}

function toAnalyticsDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseAnalyticsMeta(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function getAnalyticsRowContentName(row) {
  const meta = parseAnalyticsMeta(row?.meta_json) || {};
  return (
    normalizeAnalyticsText(row?.content_name) ||
    normalizeAnalyticsText(
      meta.content_name ||
        meta.stream_name ||
        meta.channel_name ||
        meta.movie_name ||
        meta.series_name ||
        meta.title
    ) ||
    null
  );
}

async function resolveAnalyticsContentNames(admin, rows) {
  const unresolvedKeys = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const id = String(row?.content_id || "");
        if (!id || getAnalyticsRowContentName(row)) return "";
        return `${normalizeAnalyticsLookupType(row?.content_type)}:${id}`;
      })
      .filter(Boolean)
  );
  const nameMap = new Map();
  if (!unresolvedKeys.size) return nameMap;

  const upstreams = await getAnalyticsUpstreams(admin);
  const registerResolvedName = (type, id, name) => {
    const normalizedId = String(id || "");
    const normalizedName = String(name || "").trim();
    if (!normalizedId || !normalizedName) return;
    const key = `${type}:${normalizedId}`;
    if (!nameMap.has(key)) {
      nameMap.set(key, normalizedName);
    }
    unresolvedKeys.delete(key);
  };
  const needsType = (type) => {
    for (const key of unresolvedKeys) {
      if (key.startsWith(`${type}:`)) return true;
    }
    return false;
  };

  for (const upstream of upstreams) {
    if (!unresolvedKeys.size) break;

    if (needsType("live")) {
      try {
        const live = await fetchXuiJson(upstream, "get_live_streams");
        (Array.isArray(live) ? live : []).forEach((item) => {
          registerResolvedName("live", item?.stream_id, item?.name);
        });
      } catch (err) {
        console.warn("[admin/analytics] live label resolve skipped:", err?.message || err);
      }
    }

    if (needsType("vod")) {
      try {
        const vod = await fetchXuiJson(upstream, "get_vod_streams");
        (Array.isArray(vod) ? vod : []).forEach((item) => {
          registerResolvedName("vod", item?.stream_id, item?.name);
        });
      } catch (err) {
        console.warn("[admin/analytics] vod label resolve skipped:", err?.message || err);
      }
    }

    if (needsType("series")) {
      try {
        const series = await fetchXuiJson(upstream, "get_series");
        (Array.isArray(series) ? series : []).forEach((item) => {
          registerResolvedName("series", item?.series_id || item?.stream_id, item?.name);
        });
      } catch (err) {
        console.warn("[admin/analytics] series label resolve skipped:", err?.message || err);
      }
    }
  }

  return nameMap;
}

function buildAnalyticsWindow({ days, from, to }) {
  const now = new Date();
  const defaultEnd = now;
  const defaultStart = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const start = toAnalyticsDate(from) || defaultStart;
  const end = toAnalyticsDate(to) || defaultEnd;

  return {
    start: start <= end ? start : end,
    end: end >= start ? end : start,
  };
}

function buildAnalyticsSummaryFromRows(rows, { limit, playLimit, start, end }) {
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const aggregate = new Map();
  const sessions = [];
  const sortedRows = Array.isArray(rows)
    ? [...rows].sort((left, right) => {
        const leftTime = new Date(left.created_at || 0).getTime();
        const rightTime = new Date(right.created_at || 0).getTime();
        if (left.device_id !== right.device_id) {
          return Number(left.device_id || 0) - Number(right.device_id || 0);
        }
        return leftTime - rightTime;
      })
    : [];

  const activeSessionByDevice = new Map();

  sortedRows.forEach((row, index) => {
    const deviceId = normalizeAnalyticsText(row.device_id);
    const contentId = normalizeAnalyticsText(row.content_id);
    const contentType = normalizeAnalyticsText(row.content_type).toLowerCase() || "live";
    const createdAt = toAnalyticsDate(row.created_at);
    if (!deviceId || !contentId || !createdAt) return;

    const createdAtMs = createdAt.getTime();
    const previousSession = activeSessionByDevice.get(deviceId);
    const sameContent =
      previousSession &&
      previousSession.content_id === contentId &&
      previousSession.content_type === contentType;

    if (sameContent && createdAtMs - previousSession.lastSeenAtMs <= SESSION_GAP_MS) {
      previousSession.lastSeenAtMs = createdAtMs;
      return;
    }

    const contentName = getAnalyticsRowContentName(row);

    const play = {
      play_id: normalizeAnalyticsText(row.id) || `${deviceId}:${contentType}:${contentId}:${index}`,
      counted_at: createdAt.toISOString(),
      content_id: contentId,
      content_type: contentType,
      content_name: contentName,
      device_id: deviceId,
      device_code: normalizeAnalyticsDeviceCode(row.device_code),
      model: normalizeAnalyticsText(row.model) || null,
      lastSeenAtMs: createdAtMs,
    };

    sessions.push(play);
    activeSessionByDevice.set(deviceId, play);

    const contentKey = `${contentType}:${contentId}`;
    const current = aggregate.get(contentKey) || {
      content_id: contentId,
      content_type: contentType,
      content_name: contentName,
      plays: 0,
      last_played_at: createdAt.toISOString(),
    };

    current.plays += 1;
    if (!current.content_name && contentName) current.content_name = contentName;
    if (new Date(current.last_played_at).getTime() < createdAtMs) {
      current.last_played_at = createdAt.toISOString();
    }
    aggregate.set(contentKey, current);
  });

  const plays = sessions
    .sort((left, right) => new Date(right.counted_at).getTime() - new Date(left.counted_at).getTime())
    .map(({ lastSeenAtMs, ...play }) => play);

  const items = Array.from(aggregate.values())
    .sort((left, right) => {
      if (right.plays !== left.plays) return right.plays - left.plays;
      return String(left.content_name || left.content_id).localeCompare(
        String(right.content_name || right.content_id)
      );
    })
    .slice(0, limit);

  return {
    range_days: Math.max(1, Math.ceil((end.getTime() - start.getTime() + 1) / (24 * 60 * 60 * 1000))),
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    total_plays: plays.length,
    items,
    plays: plays.slice(0, playLimit),
  };
}

/** =========================================
 *  AUTH: Login
 *  POST /v1/admin/auth/login
 *  body: { identifier, password }
 *  ========================================= */
router.post("/auth/login", async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ error: "identifier + password required" });
    }

    const [rows] = await pool.execute(
      `
      SELECT id, name, username, email, role, status, password_hash
      FROM admins
      WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?)
      LIMIT 1
      `,
      [identifier, identifier]
    );

    const admin = rows[0];
    if (!admin) return res.status(401).json({ error: "invalid credentials" });
    if (String(admin.status || "").toLowerCase() !== "active") {
      return res.status(403).json({ error: "admin disabled" });
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    await pool.execute(
      `UPDATE admins SET last_login_at=NOW(), updated_at=NOW() WHERE id=?`,
      [admin.id]
    );

    return res.json({
      admin: {
        id: admin.id,
        name: admin.name,
        username: admin.username,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (err) {
    return sendInternalError(req, res, "admin/auth/login", err);
  }
});

/** =========================================
 *  AUTH: Password reset request
 *  POST /v1/admin/auth/reset/request
 *  body: { email }
 *  ========================================= */
router.post("/auth/reset/request", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });

    const [rows] = await pool.execute(
      `SELECT id, name, email, status FROM admins WHERE LOWER(email)=LOWER(?) LIMIT 1`,
      [email]
    );

    const admin = rows[0];
    if (!admin || String(admin.status || "").toLowerCase() !== "active") {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const ttlSec = Number(env.ADMIN_RESET_TOKEN_TTL || 3600);

    await pool.execute(
      `
      INSERT INTO admin_password_resets (admin_id, token_hash, expires_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
      `,
      [admin.id, tokenHash, ttlSec]
    );

    const base = String(env.ADMIN_RESET_BASE_URL || "").trim().replace(/\/+$/, "");
    if (!base) {
      return res.status(500).json({ error: "missing ADMIN_RESET_BASE_URL" });
    }

    const resetUrl = `${base}?token=${encodeURIComponent(token)}`;
    await sendResetEmail({ to: admin.email, name: admin.name, resetUrl });

    const response = { ok: true };
    if (env.NODE_ENV !== "production") {
      response.reset_url = resetUrl;
    }

    return res.json(response);
  } catch (err) {
    const emailError = getResetEmailErrorPayload(err);
    if (emailError) {
      return res.status(emailError.status).json({
        error: emailError.error,
        hint: emailError.hint,
      });
    }
    return sendInternalError(req, res, "admin/auth/reset/request", err);
  }
});

/** =========================================
 *  AUTH: Password reset confirm
 *  POST /v1/admin/auth/reset/confirm
 *  body: { token, password }
 *  ========================================= */
router.post("/auth/reset/confirm", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!token || !password) {
      return res.status(400).json({ error: "token + password required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password too short" });
    }

    const tokenHash = hashToken(token);
    const [rows] = await pool.execute(
      `
      SELECT id, admin_id, expires_at, used_at
      FROM admin_password_resets
      WHERE token_hash=?
      ORDER BY id DESC
      LIMIT 1
      `,
      [tokenHash]
    );

    const reset = rows[0];
    if (!reset) return res.status(400).json({ error: "invalid token" });
    if (reset.used_at) return res.status(400).json({ error: "token already used" });

    const exp = new Date(reset.expires_at).getTime();
    if (!Number.isNaN(exp) && exp < Date.now()) {
      return res.status(400).json({ error: "token expired" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await pool.execute(
      `UPDATE admins SET password_hash=?, updated_at=NOW() WHERE id=?`,
      [passwordHash, reset.admin_id]
    );
    await pool.execute(
      `UPDATE admin_password_resets SET used_at=NOW() WHERE id=?`,
      [reset.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    return sendInternalError(req, res, "admin/auth/reset/confirm", err);
  }
});

/** =========================================
 *  ADMIN USERS (super admin only)
 *  ========================================= */
router.get("/admins", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const role = String(req.query.role || "").trim().toLowerCase();
    const params = [];
    let where = "";
    if (role) {
      where = "WHERE role=?";
      params.push(role);
    }

    const [rows] = await pool.execute(
      `
      SELECT id, name, username, email, role, status, last_login_at, created_at, updated_at
      FROM admins
      ${where}
      ORDER BY created_at DESC
      `,
      params
    );

    return res.json({ admins: rows });
  } catch (err) {
    return sendInternalError(req, res, "admin/admins/list", err);
  }
});

router.post("/admins", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const name = String(req.body?.name || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "admin").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "email + password required" });
    }
    if (!["super_admin", "admin", "reseller"].includes(role)) {
      return res.status(400).json({ error: "invalid role" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password too short" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await pool.execute(
      `
      INSERT INTO admins
        (name, username, email, role, status, password_hash, created_by_admin_id, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, 'active', ?, ?, NOW(), NOW())
      `,
      [name || null, username || null, email, role, passwordHash, req.admin.id]
    );

    return res.json({
      ok: true,
      admin: {
        id: result.insertId,
        name: name || null,
        username: username || null,
        email,
        role,
        status: "active",
      },
    });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "admin already exists" });
    }
    return sendInternalError(req, res, "admin/admins/create", err);
  }
});

router.patch("/admins/:id", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const adminId = Number(req.params.id);
    if (!Number.isFinite(adminId) || adminId <= 0) {
      return res.status(400).json({ error: "invalid admin id" });
    }

    const name = typeof req.body?.name !== "undefined" ? String(req.body.name).trim() : null;
    const username =
      typeof req.body?.username !== "undefined" ? String(req.body.username).trim().toLowerCase() : null;
    const email =
      typeof req.body?.email !== "undefined" ? String(req.body.email).trim().toLowerCase() : null;
    const role =
      typeof req.body?.role !== "undefined" ? String(req.body.role).trim().toLowerCase() : null;
    const status =
      typeof req.body?.status !== "undefined" ? String(req.body.status).trim().toLowerCase() : null;

    if (role && !["super_admin", "admin", "reseller"].includes(role)) {
      return res.status(400).json({ error: "invalid role" });
    }
    if (status && !["active", "disabled"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    if (req.admin?.id === adminId && (role || status)) {
      return res.status(400).json({ error: "cannot change own role/status" });
    }

    const updates = [];
    const params = [];

    if (name !== null) {
      updates.push("name=?");
      params.push(name || null);
    }
    if (username !== null) {
      updates.push("username=?");
      params.push(username || null);
    }
    if (email !== null) {
      updates.push("email=?");
      params.push(email || null);
    }
    if (role) {
      updates.push("role=?");
      params.push(role);
    }
    if (status) {
      updates.push("status=?");
      params.push(status);
    }

    if (!updates.length) {
      return res.status(400).json({ error: "no fields to update" });
    }

    params.push(adminId);
    await pool.execute(
      `UPDATE admins SET ${updates.join(", ")}, updated_at=NOW() WHERE id=?`,
      params
    );

    const [rows] = await pool.execute(
      `
      SELECT id, name, username, email, role, status, last_login_at, created_at, updated_at
      FROM admins
      WHERE id=?
      LIMIT 1
      `,
      [adminId]
    );

    if (!rows[0]) return res.status(404).json({ error: "admin not found" });

    return res.json({ ok: true, admin: rows[0] });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "admin already exists" });
    }
    return sendInternalError(req, res, "admin/admins/update", err);
  }
});

/** =========================================
 *  GET /v1/admin/devices?search=
 *  - Lists recent devices + access info
 *  - Search is case-insensitive regardless of collation
 *  ========================================= */
router.get("/devices", adminAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const onlineWindowSeconds = Number(env.DEVICE_ONLINE_WINDOW_SECONDS || 8);
    const currentContentWindowSeconds = 120;

    const whereParts = [];
    const params = [onlineWindowSeconds];

    if (search) {
      const s = `%${search}%`;
      whereParts.push(
        `(LOWER(d.device_code) LIKE LOWER(?) OR LOWER(COALESCE(d.platform,'')) LIKE LOWER(?) OR LOWER(COALESCE(d.model,'')) LIKE LOWER(?) OR LOWER(COALESCE(d.customer_phone,'')) LIKE LOWER(?))`
      );
      params.push(s, s, s, s);
    }

    if (req.admin?.role !== "super_admin") {
      whereParts.push(
        "(d.reseller_admin_id=? OR (d.reseller_admin_id IS NULL AND LOWER(COALESCE(d.status,''))='pending'))"
      );
      params.push(req.admin.id);
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const [rows] = await pool.execute(
      `
      SELECT
        d.id,
        d.device_code,
        d.customer_name,
        d.customer_phone,
        d.status,
        d.platform,
        d.model,
        d.app_version,
        d.reseller_admin_id,
        r.name AS reseller_name,
        d.plan_name,
        d.trial_expires_at,
        d.whmcs_client_id,
        d.whmcs_service_id,
        d.whmcs_account_number,
        d.whmcs_billing_status,
        d.whmcs_next_due_date,
        d.whmcs_last_sync_at,
        d.last_seen_at,
        CASE
          WHEN d.last_seen_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= ? THEN TRUE
          ELSE FALSE
        END AS online,
        d.created_at,
        d.updated_at,
        a.expires_at,
        a.max_streams
      FROM devices d
      LEFT JOIN admins r ON r.id = d.reseller_admin_id
      LEFT JOIN device_access a ON a.device_id = d.id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT 200
      `,
      params
    );

    const onlineDeviceIds = rows
      .filter((row) => Boolean(row?.online))
      .map((row) => Number(row?.id || 0))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (onlineDeviceIds.length) {
      const [currentRows] = await pool.execute(
        `
        SELECT
          ae.id,
          ae.device_id,
          ae.content_id,
          ae.content_type,
          ae.meta_json,
          ae.created_at,
          ae.event_type
        FROM analytics_events ae
        WHERE ae.device_id IN (${onlineDeviceIds.map(() => "?").join(",")})
          AND ae.content_id IS NOT NULL
          AND ae.event_type IN ('play', 'time_watched')
          AND TIMESTAMPDIFF(SECOND, ae.created_at, NOW()) <= ?
        ORDER BY ae.device_id ASC, ae.created_at DESC, ae.id DESC
        `,
        [...onlineDeviceIds, currentContentWindowSeconds]
      );

      const latestByDeviceId = new Map();
      (Array.isArray(currentRows) ? currentRows : []).forEach((row) => {
        const deviceId = String(row?.device_id || "").trim();
        if (!deviceId || latestByDeviceId.has(deviceId)) return;
        latestByDeviceId.set(deviceId, row);
      });

      if (latestByDeviceId.size) {
        const nameMap = await resolveAnalyticsContentNames(req.admin, Array.from(latestByDeviceId.values()));

        rows.forEach((row) => {
          const current = latestByDeviceId.get(String(row?.id || "").trim());
          if (!current) return;

          const lookupType = normalizeAnalyticsLookupType(current?.content_type);
          const lookupKey = `${lookupType}:${String(current?.content_id || "")}`;
          row.current_content_type = lookupType;
          row.current_content_id = String(current?.content_id || "");
          row.current_content_name = getAnalyticsRowContentName(current) || nameMap.get(lookupKey) || null;
          row.current_content_at = current?.created_at || null;
          row.current_content_event_type = String(current?.event_type || "").trim().toLowerCase() || null;
        });
      }
    }

    return res.json({ devices: rows });
  } catch (err) {
    return sendInternalError(req, res, "admin/devices", err);
  }
});

/** =========================================
 *  GET /v1/admin/analytics/streams?days=30&limit=8
 *  - Top played streams from analytics_events
 *  - Reseller admins only see their devices
 *  ========================================= */
router.get("/analytics/streams", adminAuth, async (req, res) => {
  try {
    const days = clampAnalyticsInt(req.query.days, 30, 1, 90);
    const limit = clampAnalyticsInt(req.query.limit, 8, 3, 50);
    const playLimit = clampAnalyticsInt(req.query.play_limit, 50, 1, 500);
    const from = normalizeAnalyticsText(req.query.from);
    const to = normalizeAnalyticsText(req.query.to);
    const requestedDeviceCode = normalizeAnalyticsDeviceCode(
      req.query.device_code || req.query.deviceCode
    );
    const requestedDeviceId = normalizeAnalyticsText(
      req.query.device_id || req.query.deviceId
    );
    const requestedDeviceCodes = new Set(
      parseAnalyticsCsvParam(req.query.device_codes || req.query.deviceCodes).map((code) =>
        normalizeAnalyticsDeviceCode(code)
      )
    );
    if (requestedDeviceCode) requestedDeviceCodes.add(requestedDeviceCode);

    const { start, end } = buildAnalyticsWindow({ days, from, to });

    const whereParts = [
      "ae.event_type='time_watched'",
      "ae.duration_seconds >= 60",
      "ae.content_id IS NOT NULL",
      "ae.created_at >= ?",
      "ae.created_at <= ?"
    ];
    const params = [toMysqlDatetime(start), toMysqlDatetime(end)];

    if (req.admin?.role !== "super_admin") {
      whereParts.push("d.reseller_admin_id=?");
      params.push(req.admin.id);
    }

    if (requestedDeviceId) {
      whereParts.push("ae.device_id=?");
      params.push(requestedDeviceId);
    }

    if (requestedDeviceCodes.size) {
      whereParts.push(
        `UPPER(TRIM(COALESCE(d.device_code, ''))) IN (${Array.from(requestedDeviceCodes)
          .map(() => "?")
          .join(",")})`
      );
      params.push(...Array.from(requestedDeviceCodes));
    }

    const where = `WHERE ${whereParts.join(" AND ")}`;

    const [rows] = await pool.execute(
      `
      SELECT
        ae.id,
        ae.device_id,
        d.device_code,
        d.model,
        ae.content_id,
        ae.content_type,
        ae.position_seconds,
        ae.duration_seconds,
        ae.meta_json,
        ae.created_at
      FROM analytics_events ae
      JOIN devices d ON d.id = ae.device_id
      ${where}
      ORDER BY ae.created_at DESC
      `,
      params
    );

    const summary = buildAnalyticsSummaryFromRows(rows, {
      limit,
      playLimit,
      start,
      end,
    });

    let items = summary.items;
    let plays = summary.plays;
    try {
      const upstreams = await getAnalyticsUpstreams(req.admin);
      if (upstreams.length && summary.items.length) {
        const unresolvedKeys = new Set(
          summary.items
            .map((row) => {
              const id = String(row.content_id || "");
              if (!id || row.content_name) return "";
              return `${normalizeAnalyticsLookupType(row.content_type)}:${id}`;
            })
            .filter(Boolean)
        );
        const nameMap = new Map();
        const registerResolvedName = (type, id, name) => {
          const normalizedId = String(id || "");
          const normalizedName = String(name || "").trim();
          if (!normalizedId || !normalizedName) return;
          const key = `${type}:${normalizedId}`;
          if (!nameMap.has(key)) {
            nameMap.set(key, normalizedName);
          }
          unresolvedKeys.delete(key);
        };
        const needsType = (type) => {
          for (const key of unresolvedKeys) {
            if (key.startsWith(`${type}:`)) return true;
          }
          return false;
        };

        for (const upstream of upstreams) {
          if (!unresolvedKeys.size) break;

          if (needsType("live")) {
            try {
              const live = await fetchXuiJson(upstream, "get_live_streams");
              (Array.isArray(live) ? live : []).forEach((item) => {
                registerResolvedName("live", item?.stream_id, item?.name);
              });
            } catch (err) {
              console.warn("[admin/analytics/streams] live label resolve skipped:", err?.message || err);
            }
          }

          if (needsType("vod")) {
            try {
              const vod = await fetchXuiJson(upstream, "get_vod_streams");
              (Array.isArray(vod) ? vod : []).forEach((item) => {
                registerResolvedName("vod", item?.stream_id, item?.name);
              });
            } catch (err) {
              console.warn("[admin/analytics/streams] vod label resolve skipped:", err?.message || err);
            }
          }

          if (needsType("series")) {
            try {
              const series = await fetchXuiJson(upstream, "get_series");
              (Array.isArray(series) ? series : []).forEach((item) => {
                registerResolvedName("series", item?.series_id || item?.stream_id, item?.name);
              });
            } catch (err) {
              console.warn("[admin/analytics/streams] series label resolve skipped:", err?.message || err);
            }
          }
        }

        items = summary.items.map((row) => {
          const type = normalizeAnalyticsLookupType(row.content_type);
          const id = String(row.content_id || "");
          const key = `${type}:${id}`;
          const content_name = nameMap.get(key) || row.content_name || null;
          return { ...row, content_name };
        });

        plays = summary.plays.map((row) => {
          const type = normalizeAnalyticsLookupType(row.content_type);
          const id = String(row.content_id || "");
          const key = `${type}:${id}`;
          const content_name = nameMap.get(key) || row.content_name || null;
          return { ...row, content_name };
        });
      }
    } catch (err) {
      console.warn("[admin/analytics/streams] name resolve skipped:", err?.message || err);
    }

    return res.json({
      range_days: summary.range_days,
      window_start: summary.window_start,
      window_end: summary.window_end,
      total_plays: summary.total_plays,
      items,
      plays
    });
  } catch (err) {
    return sendInternalError(req, res, "admin/analytics/streams", err);
  }
});

/** =========================================
 *  PATCH /v1/admin/devices/:code
 *  body: { customer_name?, customer_phone?, status?, max_streams?, expires_at?, reseller_admin_id? }
 *  - updates device fields + optional access limits
 *  ========================================= */
router.patch("/devices/:code", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const {
      customer_name,
      customer_phone,
      status,
      max_streams,
      expires_at,
      reseller_admin_id,
      plan_name,
      trial_expires_at,
      whmcs_client_id,
      whmcs_service_id,
      whmcs_billing_status,
      whmcs_next_due_date,
      whmcs_last_sync_at
    } = req.body || {};

    const nextStatus = status ? String(status).trim().toLowerCase() : null;
    if (nextStatus && !["pending", "active", "suspended"].includes(nextStatus)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const hasCustomer = typeof customer_name !== "undefined";
    const hasPhone = typeof customer_phone !== "undefined";
    const hasStatus = typeof nextStatus === "string" && nextStatus.length > 0;
    const hasAccess =
      typeof max_streams !== "undefined" || typeof expires_at !== "undefined";
    const hasReseller =
      typeof reseller_admin_id !== "undefined" && req.admin?.role === "super_admin";
    const hasPlan = typeof plan_name !== "undefined";
    const hasTrial = typeof trial_expires_at !== "undefined";
    const canEditWhmcs = req.admin?.role === "super_admin";
    const hasWhmcs =
      canEditWhmcs &&
      (typeof whmcs_client_id !== "undefined" ||
        typeof whmcs_service_id !== "undefined" ||
        typeof whmcs_billing_status !== "undefined" ||
        typeof whmcs_next_due_date !== "undefined" ||
        typeof whmcs_last_sync_at !== "undefined");

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id, status FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    const canAutoAssignToReseller =
      req.admin?.role !== "super_admin" &&
      !dev.reseller_admin_id &&
      String(dev.status || "").toLowerCase() === "pending";

    if (
      req.admin?.role !== "super_admin" &&
      dev.reseller_admin_id !== req.admin.id &&
      !canAutoAssignToReseller
    ) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (
      !hasCustomer &&
      !hasPhone &&
      !hasStatus &&
      !hasAccess &&
      !hasReseller &&
      !hasPlan &&
      !hasTrial &&
      !hasWhmcs &&
      !canAutoAssignToReseller
    ) {
      return res.status(400).json({ error: "no fields to update" });
    }

    if (
      hasCustomer ||
      hasPhone ||
      hasStatus ||
      hasReseller ||
      hasPlan ||
      hasTrial ||
      hasWhmcs ||
      canAutoAssignToReseller
    ) {
      const updates = [];
      const params = [];

      if (hasCustomer) {
        updates.push("customer_name=?");
        params.push(customer_name === null ? null : String(customer_name));
      }
      if (hasPhone) {
        updates.push("customer_phone=?");
        params.push(customer_phone === null ? null : String(customer_phone));
      }

      if (hasStatus) {
        updates.push("status=?");
        params.push(nextStatus);
      }

      if (hasPlan) {
        updates.push("plan_name=?");
        params.push(plan_name === null ? null : String(plan_name));
      }

      if (hasTrial) {
        updates.push("trial_expires_at=?");
        params.push(toMysqlDatetime(trial_expires_at));
      }

      if (hasReseller) {
        const resellerId = reseller_admin_id ? Number(reseller_admin_id) : null;
        if (reseller_admin_id && (!Number.isFinite(resellerId) || resellerId <= 0)) {
          return res.status(400).json({ error: "invalid reseller_admin_id" });
        }
        updates.push("reseller_admin_id=?");
        params.push(resellerId);
      } else if (canAutoAssignToReseller) {
        updates.push("reseller_admin_id=?");
        params.push(req.admin.id);
      }

      if (hasWhmcs) {
        if (typeof whmcs_client_id !== "undefined") {
          const clientId =
            whmcs_client_id === null || whmcs_client_id === ""
              ? null
              : Number(whmcs_client_id);
          if (clientId !== null && (!Number.isFinite(clientId) || clientId <= 0)) {
            return res.status(400).json({ error: "invalid whmcs_client_id" });
          }
          updates.push("whmcs_client_id=?");
          params.push(clientId);
        }

        if (typeof whmcs_service_id !== "undefined") {
          const serviceId =
            whmcs_service_id === null || whmcs_service_id === ""
              ? null
              : Number(whmcs_service_id);
          if (serviceId !== null && (!Number.isFinite(serviceId) || serviceId <= 0)) {
            return res.status(400).json({ error: "invalid whmcs_service_id" });
          }
          updates.push("whmcs_service_id=?");
          params.push(serviceId);
        }

        if (typeof whmcs_billing_status !== "undefined") {
          updates.push("whmcs_billing_status=?");
          params.push(normalizeWhmcsStatus(whmcs_billing_status));
        }

        if (typeof whmcs_next_due_date !== "undefined") {
          updates.push("whmcs_next_due_date=?");
          params.push(toMysqlDateOnly(whmcs_next_due_date));
        }

        if (typeof whmcs_last_sync_at !== "undefined") {
          updates.push("whmcs_last_sync_at=?");
          params.push(toMysqlDatetime(whmcs_last_sync_at));
        }
      }

      params.push(dev.id);
      await pool.execute(
        `UPDATE devices SET ${updates.join(", ")}, updated_at=NOW() WHERE id=?`,
        params
      );
    }

    if (hasAccess) {
      const exp = toMysqlDatetime(expires_at);
      const ms = Math.max(1, Number(max_streams || 1));

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
    }

    const [rows] = await pool.execute(
      `
      SELECT
        d.id,
        d.device_code,
        d.customer_name,
        d.customer_phone,
        d.status,
        d.platform,
        d.model,
        d.app_version,
        d.reseller_admin_id,
        r.name AS reseller_name,
        d.plan_name,
        d.trial_expires_at,
        d.whmcs_client_id,
        d.whmcs_service_id,
        d.whmcs_account_number,
        d.whmcs_billing_status,
        d.whmcs_next_due_date,
        d.whmcs_last_sync_at,
        d.last_seen_at,
        d.created_at,
        d.updated_at,
        a.expires_at,
        a.max_streams
      FROM devices d
      LEFT JOIN admins r ON r.id = d.reseller_admin_id
      LEFT JOIN device_access a ON a.device_id = d.id
      WHERE d.id=?
      LIMIT 1
      `,
      [dev.id]
    );

    let trial_reminder = { created: false, reason: "helper_unavailable" };
    if (rows[0] && typeof createWhmcsTrialReminderIfNeeded === "function") {
      try {
        trial_reminder = await createWhmcsTrialReminderIfNeeded(rows[0], req.admin?.id || null);
      } catch (trialErr) {
        console.warn("[admin/devices/update] trial reminder skipped:", trialErr?.message || trialErr);
        trial_reminder = {
          created: false,
          reason: trialErr?.code === "ER_NO_SUCH_TABLE" ? "app_notifications_missing" : "trial_reminder_failed",
        };
      }
    }

    return res.json({ ok: true, device: rows[0] || null, trial_reminder });
  } catch (err) {
    return sendInternalError(req, res, "admin/devices/update", err);
  }
});


/** =========================================
 *  POST /v1/admin/devices/:code/whmcs-sync
 *  body: { whmcs_service_id? }
 *  - super admin only
 *  - fetches WHMCS service details and updates due date/status on device
 *  ========================================= */
router.post("/devices/:code/whmcs-sync", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `
      SELECT
        id,
        device_code,
        customer_name,
        customer_phone,
        plan_name,
        status,
        whmcs_client_id,
        whmcs_service_id,
        whmcs_account_number,
        whmcs_billing_status,
        whmcs_next_due_date
      FROM devices
      WHERE device_code=?
      LIMIT 1
      `,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });

    const serviceIdInput = req.body?.whmcs_service_id;
    const resolvedServiceId = serviceIdInput ? Number(serviceIdInput) : Number(dev.whmcs_service_id || 0);
    if (!Number.isFinite(resolvedServiceId) || resolvedServiceId <= 0) {
      return res.status(400).json({ error: "whmcs_service_id required" });
    }

    const service = await fetchWhmcsServiceById(resolvedServiceId);
    if (!service) return res.status(404).json({ error: "WHMCS service not found" });

    const planName = extractWhmcsPlanName(service.raw) || dev.plan_name || null;
    const whmcsUpstream = extractWhmcsUpstreamCredentials(service.raw);
    const whmcsClient = (await fetchWhmcsClientProfileById(service.client_id)) || null;
    const whmcsCustomerName = whmcsClient?.name || dev.customer_name || null;
    const whmcsPhone = whmcsClient?.phone || dev.customer_phone || null;
    const whmcsAccountNumber = whmcsClient?.accountNumber || dev.whmcs_account_number || null;

    await pool.execute(
      `
      UPDATE devices
      SET
        customer_name=?,
        customer_phone=?,
        plan_name=?,
        whmcs_client_id=?,
        whmcs_service_id=?,
        whmcs_account_number=?,
        whmcs_billing_status=?,
        whmcs_next_due_date=?,
        whmcs_last_sync_at=NOW(),
        updated_at=NOW()
      WHERE id=?
      `,
      [
        whmcsCustomerName,
        whmcsPhone,
        planName,
        service.client_id,
        service.service_id,
        whmcsAccountNumber,
        service.status,
        service.next_due_date,
        dev.id,
      ]
    );

    if (whmcsUpstream) {
      const [upstreamRows] = await pool.execute(
        `SELECT upstream_base_url FROM device_upstream WHERE device_id=? LIMIT 1`,
        [dev.id]
      );

      const upstreamBaseUrl = normalizeBaseUrl(
        upstreamRows[0]?.upstream_base_url || env.XUI_BASE_URL
      );

      if (upstreamBaseUrl) {
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
          [
            dev.id,
            upstreamBaseUrl,
            encryptString(whmcsUpstream.username),
            encryptString(whmcsUpstream.password),
          ]
        );
      }
    }

    const [rows] = await pool.execute(
      `
      SELECT
        d.id,
        d.device_code,
        d.customer_name,
        d.customer_phone,
        d.plan_name,
        d.status,
        d.whmcs_client_id,
        d.whmcs_service_id,
        d.whmcs_account_number,
        d.whmcs_billing_status,
        d.whmcs_next_due_date,
        d.whmcs_last_sync_at
      FROM devices d
      WHERE d.id=?
      LIMIT 1
      `,
      [dev.id]
    );

    let reminder = { created: false, reason: "helper_unavailable" };
    if (rows[0] && typeof createWhmcsReminderIfNeeded === "function") {
      try {
        reminder = await createWhmcsReminderIfNeeded(rows[0], req.admin?.id || null);
      } catch (remErr) {
        console.warn("[admin/devices/whmcs-sync] reminder creation skipped:", remErr?.message || remErr);
        reminder = {
          created: false,
          reason: remErr?.code === "ER_NO_SUCH_TABLE" ? "app_notifications_missing" : "reminder_failed",
        };
      }
    }

    let payment_confirmation = { created: false, reason: "helper_unavailable" };
    if (rows[0] && typeof createWhmcsPaymentConfirmationIfNeeded === "function") {
      try {
        payment_confirmation = await createWhmcsPaymentConfirmationIfNeeded(dev, rows[0], req.admin?.id || null);
      } catch (confirmErr) {
        console.warn("[admin/devices/whmcs-sync] payment confirmation skipped:", confirmErr?.message || confirmErr);
        payment_confirmation = {
          created: false,
          reason: confirmErr?.code === "ER_NO_SUCH_TABLE" ? "app_notifications_missing" : "payment_confirmation_failed",
        };
      }
    }

    let trial_reminder = { created: false, reason: "helper_unavailable" };
    if (rows[0] && typeof createWhmcsTrialReminderIfNeeded === "function") {
      try {
        trial_reminder = await createWhmcsTrialReminderIfNeeded(rows[0], req.admin?.id || null);
      } catch (trialErr) {
        console.warn("[admin/devices/whmcs-sync] trial reminder skipped:", trialErr?.message || trialErr);
        trial_reminder = {
          created: false,
          reason: trialErr?.code === "ER_NO_SUCH_TABLE" ? "app_notifications_missing" : "trial_reminder_failed",
        };
      }
    }

    return res.json({
      ok: true,
      device: rows[0] || null,
      whmcs: {
        service_id: service.service_id,
        client_id: service.client_id,
        status: service.status,
        next_due_date: service.next_due_date,
        plan_name: planName,
        account_number: whmcsAccountNumber,
      },
      whmcs_credentials_synced: Boolean(whmcsUpstream),
      reminder,
      payment_confirmation,
      trial_reminder,
    });
  } catch (err) {
    if (err?.message === "WHMCS API not configured") {
      return res.status(500).json({
        error: "WHMCS API not configured",
        hint: "Set WHMCS_API_URL, WHMCS_API_IDENTIFIER, WHMCS_API_SECRET",
      });
    }

    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "Database schema mismatch",
        hint:
          "Run DB migration for devices WHMCS fields (whmcs_client_id, whmcs_service_id, whmcs_billing_status, whmcs_next_due_date, whmcs_last_sync_at) and app_notifications table",
      });
    }

    if (typeof err?.status === "number" && err.status >= 400 && err.status < 600) {
      const upstreamStatus = Number(err.status);
      const upstreamBody = String(err?.body || "").trim();
      return res.status(502).json({
        error: `WHMCS request failed (HTTP ${upstreamStatus})`,
        hint:
          "Check WHMCS_API_URL (usually /includes/api.php), WHMCS API credentials, and firewall/IP allowlist",
        ...(upstreamBody ? { upstream: upstreamBody.slice(0, 240) } : {}),
      });
    }

    return sendInternalError(req, res, "admin/devices/whmcs-sync", err);
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/activate
 *  body: { expires_at, max_streams }
 *  - sets device active
 *  - upserts device_access
 *  ========================================= */
router.post("/devices/:code/activate", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const { expires_at, max_streams } = req.body || {};

    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

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
    return sendInternalError(req, res, "admin/activate", err);
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/suspend
 *  - sets device suspended
 *  ========================================= */
router.post("/devices/:code/suspend", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    await pool.execute(
      `UPDATE devices SET status='suspended', updated_at=NOW() WHERE id=?`,
      [dev.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    return sendInternalError(req, res, "admin/suspend", err);
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/upstream
 *  body: { upstream_base_url, username, password }
 *  - stores encrypted upstream creds per device
 *  ========================================= */
/** =========================================
 *  GET /v1/admin/devices/:code/upstream
 *  - returns stored upstream creds for admin UI
 *  ========================================= */
router.get("/devices/:code/upstream", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    const [rows] = await pool.execute(
      `SELECT upstream_base_url, enc_username, enc_password
       FROM device_upstream
       WHERE device_id=?
       LIMIT 1`,
      [dev.id]
    );

    const row = rows[0];
    if (!row) {
      return res.json({
        configured: false,
        upstream_base_url: "",
        username: "",
        password: ""
      });
    }

    const username = decryptString(row.enc_username);
    const password = decryptString(row.enc_password);

    return res.json({
      configured: true,
      upstream_base_url: row.upstream_base_url || "",
      username,
      password
    });
  } catch (err) {
    return sendInternalError(req, res, "admin/upstream/get", err);
  }
});

router.post("/devices/:code/upstream", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const { upstream_base_url, username, password } = req.body || {};

    if (!code) return res.status(400).json({ error: "device code required" });
    if (!username || !password) {
      return res.status(400).json({ error: "username + password required" });
    }

    const baseInput = String(upstream_base_url || "").trim();
    const baseCandidate = baseInput || env.XUI_BASE_URL;
    const base = normalizeBaseUrl(baseCandidate);
    if (!base) {
      return res.status(400).json({ error: "missing upstream_base_url" });
    }

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

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
    return sendInternalError(req, res, "admin/upstream", err);
  }
});

/** =========================================
 *  GET /v1/admin/devices/:code/parental
 *  - returns whether adult PIN is configured
 *  ========================================= */
router.get("/devices/:code/parental", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    const [rows] = await pool.execute(
      `SELECT adult_pin_enc FROM device_access WHERE device_id=? LIMIT 1`,
      [dev.id]
    );
    const enabled = Boolean(rows[0]?.adult_pin_enc);

    return res.json({ enabled });
  } catch (err) {
    return sendInternalError(req, res, "admin/parental/get", err);
  }
});

/** =========================================
 *  PUT /v1/admin/devices/:code/parental
 *  body: { pin }
 *  - stores encrypted adult PIN per device
 *  ========================================= */
router.put("/devices/:code/parental", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    const pin = normalizePin(req.body?.pin);
    if (!code) return res.status(400).json({ error: "device code required" });
    if (!pin) return res.status(400).json({ error: "pin must be 4 digits" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    const encPin = encryptString(pin);

    await pool.execute(
      `
      INSERT INTO device_access (device_id, adult_pin_enc, updated_at)
      VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        adult_pin_enc=VALUES(adult_pin_enc),
        updated_at=NOW()
      `,
      [dev.id, encPin]
    );

    return res.json({ ok: true, enabled: true });
  } catch (err) {
    return sendInternalError(req, res, "admin/parental/set", err);
  }
});

/** =========================================
 *  DELETE /v1/admin/devices/:code/parental
 *  - clears adult PIN for a device
 *  ========================================= */
router.delete("/devices/:code/parental", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );

    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    await pool.execute(
      `UPDATE device_access SET adult_pin_enc=NULL, updated_at=NOW() WHERE device_id=?`,
      [dev.id]
    );

    return res.json({ ok: true, enabled: false });
  } catch (err) {
    return sendInternalError(req, res, "admin/parental/reset", err);
  }
});

/** =========================================
 *  DELETE /v1/admin/devices/:code
 *  - deletes device + cascades access/upstream/analytics
 *  ========================================= */
router.delete("/devices/:code", adminAuth, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ error: "device code required" });

    const [devRows] = await pool.execute(
      `SELECT id, reseller_admin_id FROM devices WHERE device_code=? LIMIT 1`,
      [code]
    );
    const dev = devRows[0];
    if (!dev) return res.status(404).json({ error: "device not found" });
    if (req.admin?.role !== "super_admin" && dev.reseller_admin_id !== req.admin.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    await pool.execute(`DELETE FROM devices WHERE id=?`, [dev.id]);

    return res.json({ ok: true });
  } catch (err) {
    return sendInternalError(req, res, "admin/delete", err);
  }
});

module.exports = router;
