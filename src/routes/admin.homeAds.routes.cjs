const { Router } = require("express");
const { adminAuth } = require("../middleware/adminAuth.cjs");
const { pool } = require("../db/pool.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

const SLOT_ORDER = ["home_left", "home_right", "movies", "series"];
const VALID_SLOT_KEYS = new Set(SLOT_ORDER);
const VALID_MEDIA_TYPES = new Set(["poster", "video"]);

function requireSuperAdmin(req, res) {
  if (!req.admin || req.admin.role !== "super_admin") {
    res.status(403).json({ error: "super admin required" });
    return false;
  }
  return true;
}

function normStr(v, max = 255) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normBool(v, fallback = null) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function validHttpUrl(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function validLaunchTarget(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return true;
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(s);
}

function normSlotKey(v) {
  const s = String(v || "").trim().toLowerCase();
  return VALID_SLOT_KEYS.has(s) ? s : null;
}

function normMediaType(v) {
  const s = String(v || "poster").trim().toLowerCase();
  return VALID_MEDIA_TYPES.has(s) ? s : null;
}

function toSqlDateTime(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function isSchemaMismatch(err) {
  const code = String(err?.code || "").trim();
  return ["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR", "ER_BAD_TABLE_ERROR"].includes(code);
}

router.get("/home-ads", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const [rows] = await pool.execute(
      `
      SELECT
        ha.id,
        ha.slot_key,
        ha.title,
        ha.poster_url,
        ha.launch_url,
        ha.media_type,
        ha.media_url,
        ha.is_active,
        ha.starts_at,
        ha.ends_at,
        ha.created_by_admin_id,
        a.name AS created_by_admin_name,
        ha.created_at,
        ha.updated_at
      FROM app_home_ads ha
      LEFT JOIN admins a ON a.id = ha.created_by_admin_id
      ORDER BY FIELD(ha.slot_key, 'home_left', 'home_right', 'movies', 'series'), ha.id ASC
      `
    );
    return res.json({ ads: rows });
  } catch (err) {
    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "app_home_ads table missing",
        hint: "Run DB migration for app_home_ads table",
      });
    }
    return sendInternalError(req, res, "admin/home-ads/list", err);
  }
});

router.put("/home-ads/:slotKey", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const slotKey = normSlotKey(req.params?.slotKey);
    if (!slotKey) return res.status(400).json({ error: "invalid slotKey" });

    const title = normStr(req.body?.title, 190) || null;
    const posterUrl = normStr(req.body?.poster_url, 2000) || null;
    const launchUrl = normStr(req.body?.launch_url ?? req.body?.launcher_url, 2000) || null;
    const mediaType = normMediaType(req.body?.media_type || "poster");
    const mediaUrl = normStr(req.body?.media_url, 2000) || null;
    const isActive = normBool(req.body?.is_active, true);
    const startsAt = toSqlDateTime(req.body?.starts_at);
    const endsAt = toSqlDateTime(req.body?.ends_at);

    if (!mediaType) return res.status(400).json({ error: "invalid media_type" });
    if (typeof isActive !== "boolean") return res.status(400).json({ error: "invalid is_active" });
    if (!validHttpUrl(posterUrl)) return res.status(400).json({ error: "invalid poster_url" });
    if (!validLaunchTarget(launchUrl)) return res.status(400).json({ error: "invalid launch_url" });
    if (!validHttpUrl(mediaUrl)) return res.status(400).json({ error: "invalid media_url" });
    if (typeof startsAt === "undefined") return res.status(400).json({ error: "invalid starts_at" });
    if (typeof endsAt === "undefined") return res.status(400).json({ error: "invalid ends_at" });
    if (mediaType === "video" && !mediaUrl) {
      return res.status(400).json({ error: "media_url required when media_type=video" });
    }

    await pool.execute(
      `
      INSERT INTO app_home_ads
        (slot_key, title, poster_url, launch_url, media_type, media_url, is_active, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        title=VALUES(title),
        poster_url=VALUES(poster_url),
        launch_url=VALUES(launch_url),
        media_type=VALUES(media_type),
        media_url=VALUES(media_url),
        is_active=VALUES(is_active),
        starts_at=VALUES(starts_at),
        ends_at=VALUES(ends_at),
        created_by_admin_id=VALUES(created_by_admin_id),
        updated_at=NOW()
      `,
      [
        slotKey,
        title,
        posterUrl,
        launchUrl,
        mediaType,
        mediaUrl,
        isActive ? 1 : 0,
        startsAt,
        endsAt,
        req.admin?.id || null,
      ]
    );

    const [rows] = await pool.execute(
      `SELECT * FROM app_home_ads WHERE slot_key=? LIMIT 1`,
      [slotKey]
    );
    return res.json({ ok: true, ad: rows[0] || null });
  } catch (err) {
    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "app_home_ads table missing",
        hint: "Run DB migration for app_home_ads table",
      });
    }
    return sendInternalError(req, res, "admin/home-ads/upsert", err);
  }
});

module.exports = router;
