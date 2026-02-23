const { Router } = require("express");
const { adminAuth } = require("../middleware/adminAuth.cjs");
const { pool } = require("../db/pool.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

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

function toInt(v, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function normStatus(v) {
  const s = String(v || "active").trim().toLowerCase();
  if (!["active", "inactive"].includes(s)) return null;
  return s;
}

function normPlatform(v) {
  const s = String(v || "all").trim().toLowerCase();
  if (!s) return "all";
  return s.length > 32 ? s.slice(0, 32) : s;
}

function normScope(v) {
  const s = String(v || "mass").trim().toLowerCase();
  if (!["mass", "device"].includes(s)) return null;
  return s;
}

function normBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return null;
}

function wordCount(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

function isSchemaMismatch(err) {
  const code = String(err?.code || "").trim();
  return ["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR", "ER_BAD_TABLE_ERROR"].includes(code);
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

async function resolveDeviceId({ targetScope, targetDeviceId, targetDeviceCode }) {
  if (targetScope !== "device") return null;

  const idInput = toInt(targetDeviceId, 0);
  if (idInput > 0) {
    const [rows] = await pool.execute(
      `SELECT id FROM devices WHERE id=? LIMIT 1`,
      [idInput]
    );
    if (!rows[0]) return undefined;
    return Number(rows[0].id);
  }

  const code = normStr(targetDeviceCode, 64).toUpperCase();
  if (!code) return undefined;

  const [rows] = await pool.execute(
    `SELECT id FROM devices WHERE UPPER(device_code)=? LIMIT 1`,
    [code]
  );

  if (!rows[0]) return undefined;
  return Number(rows[0].id);
}

router.get("/notifications", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const status = normStatus(req.query.status) || null;
    const targetPlatform = normPlatform(req.query.target_platform || req.query.platform || "") || null;
    const targetScope = normScope(req.query.target_scope || req.query.scope || "") || null;
    const limit = Math.max(1, Math.min(500, toInt(req.query.limit, 200)));

    const where = [];
    const params = [];

    if (status) {
      where.push("n.status=?");
      params.push(status);
    }

    if (targetPlatform && targetPlatform !== "all") {
      where.push("n.target_platform=?");
      params.push(targetPlatform);
    }

    if (targetScope) {
      where.push("COALESCE(n.target_scope, 'mass')=?");
      params.push(targetScope);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.execute(
      `
      SELECT
        n.id,
        n.title,
        n.message,
        n.is_ticker,
        n.ticker_text,
        n.status,
        n.target_scope,
        n.target_platform,
        n.target_device_id,
        d.device_code AS target_device_code,
        n.starts_at,
        n.ends_at,
        n.created_by_admin_id,
        a.name AS created_by_admin_name,
        n.created_at,
        n.updated_at
      FROM app_notifications n
      LEFT JOIN admins a ON a.id = n.created_by_admin_id
      LEFT JOIN devices d ON d.id = n.target_device_id
      ${whereSql}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${limit}
      `,
      params
    );

    return res.json({ notifications: rows.map(normalizeNotificationTimestamps) });
  } catch (err) {
    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "app_notifications table missing",
        hint: "Run DB migration for app_notifications table/columns (target_scope, target_device_id)",
      });
    }
    return sendInternalError(req, res, "admin/notifications/list", err);
  }
});

router.post("/notifications", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const title = normStr(req.body?.title, 190);
    const message = normStr(req.body?.message, 3000) || null;
    const isTicker = normBool(req.body?.is_ticker);
    const tickerText = normStr(req.body?.ticker_text, 6000) || null;
    const status = normStatus(req.body?.status || "active");
    const targetScope = normScope(req.body?.target_scope || req.body?.scope || "mass");
    const targetPlatform = normPlatform(req.body?.target_platform || req.body?.platform || "all");
    const startsAt = toSqlDateTime(req.body?.starts_at);
    const endsAt = toSqlDateTime(req.body?.ends_at);
    const targetDeviceId = await resolveDeviceId({
      targetScope,
      targetDeviceId: req.body?.target_device_id,
      targetDeviceCode: req.body?.target_device_code,
    });

    if (!title) return res.status(400).json({ error: "title required" });
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "is_ticker") && isTicker === null) {
      return res.status(400).json({ error: "invalid is_ticker" });
    }
    if (tickerText && wordCount(tickerText) > 100) {
      return res.status(400).json({ error: "ticker_text must be 100 words or fewer" });
    }
    if (!status) return res.status(400).json({ error: "invalid status" });
    if (!targetScope) return res.status(400).json({ error: "invalid target_scope" });
    if (typeof startsAt === "undefined") return res.status(400).json({ error: "invalid starts_at" });
    if (typeof endsAt === "undefined") return res.status(400).json({ error: "invalid ends_at" });

    if (targetScope === "device" && !targetDeviceId) {
      return res.status(400).json({ error: "target_device_code or target_device_id required for device scope" });
    }

    await pool.execute(
      `
      INSERT INTO app_notifications
        (title, message, is_ticker, ticker_text, status, target_scope, target_platform, target_device_id, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        title,
        message,
        isTicker ? 1 : 0,
        tickerText,
        status,
        targetScope,
        targetScope === "mass" ? (targetPlatform || "all") : "all",
        targetScope === "device" ? targetDeviceId : null,
        startsAt,
        endsAt,
        req.admin?.id || null,
      ]
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "app_notifications table missing",
        hint: "Run DB migration for app_notifications table/columns (target_scope, target_device_id)",
      });
    }
    return sendInternalError(req, res, "admin/notifications/create", err);
  }
});

router.patch("/notifications/:id", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const id = toInt(req.params?.id, 0);
    if (!id || id <= 0) return res.status(400).json({ error: "invalid id" });

    const updates = [];
    const params = [];

    if (typeof req.body?.title !== "undefined") {
      const title = normStr(req.body?.title, 190);
      if (!title) return res.status(400).json({ error: "title required" });
      updates.push("title=?");
      params.push(title);
    }

    if (typeof req.body?.message !== "undefined") {
      const message = normStr(req.body?.message, 3000) || null;
      updates.push("message=?");
      params.push(message);
    }

    if (typeof req.body?.is_ticker !== "undefined") {
      const isTicker = normBool(req.body?.is_ticker);
      if (isTicker === null) return res.status(400).json({ error: "invalid is_ticker" });
      updates.push("is_ticker=?");
      params.push(isTicker ? 1 : 0);
    }

    if (typeof req.body?.ticker_text !== "undefined") {
      const tickerText = normStr(req.body?.ticker_text, 3000) || null;
      if (tickerText && wordCount(tickerText) > 100) {
        return res.status(400).json({ error: "ticker_text must be 100 words or fewer" });
      }
      updates.push("ticker_text=?");
      params.push(tickerText);
    }

    if (typeof req.body?.status !== "undefined") {
      const status = normStatus(req.body?.status);
      if (!status) return res.status(400).json({ error: "invalid status" });
      updates.push("status=?");
      params.push(status);
    }

    let targetScope = null;
    if (typeof req.body?.target_scope !== "undefined" || typeof req.body?.scope !== "undefined") {
      targetScope = normScope(req.body?.target_scope || req.body?.scope || "mass");
      if (!targetScope) return res.status(400).json({ error: "invalid target_scope" });
      updates.push("target_scope=?");
      params.push(targetScope);
    }

    if (typeof req.body?.target_platform !== "undefined" || typeof req.body?.platform !== "undefined") {
      const targetPlatform = normPlatform(req.body?.target_platform || req.body?.platform || "all");
      updates.push("target_platform=?");
      params.push(targetPlatform || "all");
    }

    if (
      typeof req.body?.target_device_id !== "undefined" ||
      typeof req.body?.target_device_code !== "undefined" ||
      targetScope === "device"
    ) {
      const effectiveScope = targetScope || "device";
      const targetDeviceId = await resolveDeviceId({
        targetScope: effectiveScope,
        targetDeviceId: req.body?.target_device_id,
        targetDeviceCode: req.body?.target_device_code,
      });

      if (effectiveScope === "device" && !targetDeviceId) {
        return res.status(400).json({ error: "target_device_code or target_device_id required for device scope" });
      }

      updates.push("target_device_id=?");
      params.push(targetDeviceId || null);
    }

    if (typeof req.body?.starts_at !== "undefined") {
      const startsAt = toSqlDateTime(req.body?.starts_at);
      if (typeof startsAt === "undefined") return res.status(400).json({ error: "invalid starts_at" });
      updates.push("starts_at=?");
      params.push(startsAt);
    }

    if (typeof req.body?.ends_at !== "undefined") {
      const endsAt = toSqlDateTime(req.body?.ends_at);
      if (typeof endsAt === "undefined") return res.status(400).json({ error: "invalid ends_at" });
      updates.push("ends_at=?");
      params.push(endsAt);
    }

    if (!updates.length) return res.status(400).json({ error: "nothing to update" });

    params.push(id);

    const [result] = await pool.execute(
      `UPDATE app_notifications SET ${updates.join(", ")}, updated_at=NOW() WHERE id=? LIMIT 1`,
      params
    );

    if (!result?.affectedRows) return res.status(404).json({ error: "notification not found" });

    return res.json({ ok: true });
  } catch (err) {
    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "app_notifications table missing",
        hint: "Run DB migration for app_notifications table/columns (target_scope, target_device_id)",
      });
    }
    return sendInternalError(req, res, "admin/notifications/update", err);
  }
});

router.delete("/notifications/:id", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const id = toInt(req.params?.id, 0);
    if (!id || id <= 0) return res.status(400).json({ error: "invalid id" });

    const [result] = await pool.execute(
      `DELETE FROM app_notifications WHERE id=? LIMIT 1`,
      [id]
    );

    if (!result?.affectedRows) return res.status(404).json({ error: "notification not found" });

    return res.json({ ok: true });
  } catch (err) {
    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "app_notifications table missing",
        hint: "Run DB migration for app_notifications table/columns (target_scope, target_device_id)",
      });
    }
    return sendInternalError(req, res, "admin/notifications/delete", err);
  }
});

module.exports = router;
