const { Router } = require("express");
const { adminAuth } = require("../middleware/adminAuth.cjs");
const { pool } = require("../db/pool.cjs");

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

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function normChannel(v) {
  const s = String(v || "direct").trim().toLowerCase();
  if (!["direct", "play", "amazon"].includes(s)) return null;
  return s;
}

function normStatus(v) {
  const s = String(v || "active").trim().toLowerCase();
  if (!["active", "inactive"].includes(s)) return null;
  return s;
}

function normPlatform(v) {
  const s = String(v || "android_tv").trim().toLowerCase();
  if (!s) return null;
  if (s.length > 32) return null;
  return s;
}

function validSha256(v) {
  if (v === null || typeof v === "undefined" || String(v).trim() === "") return true;
  return /^[a-f0-9]{64}$/i.test(String(v).trim());
}

function validHttpUrl(v) {
  try {
    const u = new URL(String(v || ""));
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function sendDebugError(res, scope, err, extra = {}) {
  console.error(`[${scope}] error:`, err);
  return res.status(500).json({
    error: "internal error",
    code: err?.code || null,
    sqlState: err?.sqlState || null,
    errno: typeof err?.errno === "number" ? err.errno : null,
    sqlMessage: err?.sqlMessage || err?.message || null,
    hint: extra.hint || null,
  });
}

router.get("/app-updates", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const channel = normChannel(req.query.channel) || null;
    const platform = normPlatform(req.query.platform) || null;
    const status = normStatus(req.query.status) || null;
    const limit = Math.max(1, Math.min(500, toInt(req.query.limit) || 200));

    const where = [];
    const params = [];
    if (channel) {
      where.push("au.channel=?");
      params.push(channel);
    }
    if (platform) {
      where.push("au.platform=?");
      params.push(platform);
    }
    if (status) {
      where.push("au.status=?");
      params.push(status);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.execute(
      `
      SELECT
        au.id,
        au.channel,
        au.platform,
        au.version_code,
        au.version_name,
        au.apk_url,
        au.sha256,
        au.force_update,
        au.status,
        au.notes,
        au.created_by_admin_id,
        a.name AS created_by_admin_name,
        au.created_at,
        au.updated_at
      FROM app_updates au
      LEFT JOIN admins a ON a.id = au.created_by_admin_id
      ${whereSql}
      ORDER BY au.updated_at DESC, au.id DESC
      LIMIT ${limit}
      `,
      params
    );

    return res.json({ updates: rows });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.status(500).json({
        error: "app_updates table missing",
        hint: "Run DB migration to create app_updates table",
      });
    }
    return sendDebugError(res, "admin/app-updates/list", err, {
      hint: "Check app_updates table columns and admins table name column",
    });
  }
});

router.post("/app-updates", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const channel = normChannel(req.body?.channel);
    const platform = normPlatform(req.body?.platform);
    const versionCode = toInt(req.body?.version_code);
    const versionName = normStr(req.body?.version_name, 64);
    const apkUrl = normStr(req.body?.apk_url, 1000);
    const sha256 = normStr(req.body?.sha256, 64) || null;
    const status = normStatus(req.body?.status || "active");
    const forceUpdate = toBool(req.body?.force_update ?? req.body?.force);
    const notes = normStr(req.body?.notes, 500) || null;

    if (!channel) return res.status(400).json({ error: "invalid channel" });
    if (!platform) return res.status(400).json({ error: "invalid platform" });
    if (!Number.isFinite(versionCode) || versionCode <= 0) {
      return res.status(400).json({ error: "invalid version_code" });
    }
    if (!versionName) return res.status(400).json({ error: "version_name required" });
    if (!apkUrl || !validHttpUrl(apkUrl)) {
      return res.status(400).json({ error: "valid apk_url required" });
    }
    if (!validSha256(sha256)) {
      return res.status(400).json({ error: "sha256 must be 64 hex chars" });
    }
    if (!status) return res.status(400).json({ error: "invalid status" });

    const [result] = await pool.execute(
      `
      INSERT INTO app_updates
        (channel, platform, version_code, version_name, apk_url, sha256, force_update, status, notes, created_by_admin_id, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        channel,
        platform,
        versionCode,
        versionName,
        apkUrl,
        sha256,
        forceUpdate ? 1 : 0,
        status,
        notes,
        req.admin?.id || null,
      ]
    );

    const [rows] = await pool.execute(
      `SELECT * FROM app_updates WHERE id=? LIMIT 1`,
      [result.insertId]
    );

    return res.status(201).json({ ok: true, update: rows[0] || null });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "version already exists for channel/platform" });
    }
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.status(500).json({
        error: "app_updates table missing",
        hint: "Run DB migration to create app_updates table",
      });
    }
    return sendDebugError(res, "admin/app-updates/create", err);
  }
});

router.patch("/app-updates/:id", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const id = toInt(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const updates = [];
    const params = [];

    if (typeof req.body?.channel !== "undefined") {
      const channel = normChannel(req.body?.channel);
      if (!channel) return res.status(400).json({ error: "invalid channel" });
      updates.push("channel=?");
      params.push(channel);
    }

    if (typeof req.body?.platform !== "undefined") {
      const platform = normPlatform(req.body?.platform);
      if (!platform) return res.status(400).json({ error: "invalid platform" });
      updates.push("platform=?");
      params.push(platform);
    }

    if (typeof req.body?.version_code !== "undefined") {
      const versionCode = toInt(req.body?.version_code);
      if (!Number.isFinite(versionCode) || versionCode <= 0) {
        return res.status(400).json({ error: "invalid version_code" });
      }
      updates.push("version_code=?");
      params.push(versionCode);
    }

    if (typeof req.body?.version_name !== "undefined") {
      const versionName = normStr(req.body?.version_name, 64);
      if (!versionName) return res.status(400).json({ error: "version_name required" });
      updates.push("version_name=?");
      params.push(versionName);
    }

    if (typeof req.body?.apk_url !== "undefined") {
      const apkUrl = normStr(req.body?.apk_url, 1000);
      if (!apkUrl || !validHttpUrl(apkUrl)) {
        return res.status(400).json({ error: "valid apk_url required" });
      }
      updates.push("apk_url=?");
      params.push(apkUrl);
    }

    if (typeof req.body?.sha256 !== "undefined") {
      const sha256 = normStr(req.body?.sha256, 64) || null;
      if (!validSha256(sha256)) {
        return res.status(400).json({ error: "sha256 must be 64 hex chars" });
      }
      updates.push("sha256=?");
      params.push(sha256);
    }

    if (typeof req.body?.status !== "undefined") {
      const status = normStatus(req.body?.status);
      if (!status) return res.status(400).json({ error: "invalid status" });
      updates.push("status=?");
      params.push(status);
    }

    if (typeof req.body?.force_update !== "undefined" || typeof req.body?.force !== "undefined") {
      const forceUpdate = toBool(req.body?.force_update ?? req.body?.force);
      updates.push("force_update=?");
      params.push(forceUpdate ? 1 : 0);
    }

    if (typeof req.body?.notes !== "undefined") {
      const notes = normStr(req.body?.notes, 500) || null;
      updates.push("notes=?");
      params.push(notes);
    }

    if (!updates.length) {
      return res.status(400).json({ error: "no fields to update" });
    }

    params.push(id);

    const [result] = await pool.execute(
      `UPDATE app_updates SET ${updates.join(", ")}, updated_at=NOW() WHERE id=?`,
      params
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: "app update not found" });
    }

    const [rows] = await pool.execute(
      `SELECT * FROM app_updates WHERE id=? LIMIT 1`,
      [id]
    );

    return res.json({ ok: true, update: rows[0] || null });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "version already exists for channel/platform" });
    }
    return sendDebugError(res, "admin/app-updates/update", err);
  }
});

router.delete("/app-updates/:id", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const id = toInt(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const [result] = await pool.execute(`DELETE FROM app_updates WHERE id=?`, [id]);
    if (!result.affectedRows) {
      return res.status(404).json({ error: "app update not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    return sendDebugError(res, "admin/app-updates/delete", err);
  }
});

module.exports = router;
