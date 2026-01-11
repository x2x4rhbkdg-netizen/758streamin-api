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
const { pool } = require("../db/pool.cjs");
const { encryptString } = require("../utils/cryptoVault.cjs");
const { sendResetEmail } = require("../utils/email.cjs");
const { env } = require("../config/env.cjs");

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
    console.error("[admin/auth/login] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    if (err?.code === "EMAIL_NOT_CONFIGURED") {
      return res.status(500).json({ error: "email not configured" });
    }
    console.error("[admin/auth/reset/request] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/auth/reset/confirm] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/admins/list] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/admins/create] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/admins/update] error:", err);
    return res.status(500).json({ error: "internal error" });
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

    const whereParts = [];
    const params = [];

    if (search) {
      const s = `%${search}%`;
      whereParts.push(
        `(LOWER(d.device_code) LIKE LOWER(?) OR LOWER(COALESCE(d.platform,'')) LIKE LOWER(?) OR LOWER(COALESCE(d.model,'')) LIKE LOWER(?) OR LOWER(COALESCE(d.customer_phone,'')) LIKE LOWER(?))`
      );
      params.push(s, s, s, s);
    }

    if (req.admin?.role !== "super_admin") {
      whereParts.push("d.reseller_admin_id=?");
      params.push(req.admin.id);
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const [rows] = await pool.execute(
      `
      SELECT
        d.device_code,
        d.customer_name,
        d.customer_phone,
        d.status,
        d.platform,
        d.model,
        d.app_version,
        d.reseller_admin_id,
        r.name AS reseller_name,
        d.last_seen_at,
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

    return res.json({ devices: rows });
  } catch (err) {
    console.error("[admin/devices] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  GET /v1/admin/analytics/streams?days=30&limit=8
 *  - Top played streams from analytics_events
 *  - Reseller admins only see their devices
 *  ========================================= */
router.get("/analytics/streams", adminAuth, async (req, res) => {
  try {
    const daysRaw = Number(req.query.days || 30);
    const limitRaw = Number(req.query.limit || 8);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, daysRaw)) : 30;
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(3, limitRaw)) : 8;

    const whereParts = [
      "ae.event_type='play'",
      "ae.content_id IS NOT NULL",
      "ae.created_at >= (NOW() - INTERVAL ? DAY)"
    ];
    const params = [days];

    if (req.admin?.role !== "super_admin") {
      whereParts.push("d.reseller_admin_id=?");
      params.push(req.admin.id);
    }

    const where = `WHERE ${whereParts.join(" AND ")}`;

    const [totalRows] = await pool.execute(
      `
      SELECT COUNT(*) AS total
      FROM analytics_events ae
      JOIN devices d ON d.id = ae.device_id
      ${where}
      `,
      params
    );

    const totalPlays = Number(totalRows?.[0]?.total || 0);

    const [rows] = await pool.execute(
      `
      SELECT
        ae.content_id,
        ae.content_type,
        COUNT(*) AS plays,
        MAX(ae.created_at) AS last_played_at
      FROM analytics_events ae
      JOIN devices d ON d.id = ae.device_id
      ${where}
      GROUP BY ae.content_id, ae.content_type
      ORDER BY plays DESC
      LIMIT ${limit}
      `,
      params
    );

    return res.json({
      range_days: days,
      total_plays: totalPlays,
      items: rows
    });
  } catch (err) {
    console.error("[admin/analytics/streams] error:", err);
    return res.status(500).json({ error: "internal error" });
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

    const { customer_name, customer_phone, status, max_streams, expires_at, reseller_admin_id } =
      req.body || {};

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

    if (!hasCustomer && !hasPhone && !hasStatus && !hasAccess && !hasReseller) {
      return res.status(400).json({ error: "no fields to update" });
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

    if (hasCustomer || hasPhone || hasStatus || hasReseller) {
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

      if (hasReseller) {
        const resellerId = reseller_admin_id ? Number(reseller_admin_id) : null;
        if (reseller_admin_id && (!Number.isFinite(resellerId) || resellerId <= 0)) {
          return res.status(400).json({ error: "invalid reseller_admin_id" });
        }
        updates.push("reseller_admin_id=?");
        params.push(resellerId);
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
        d.device_code,
        d.customer_name,
        d.customer_phone,
        d.status,
        d.platform,
        d.model,
        d.app_version,
        d.reseller_admin_id,
        r.name AS reseller_name,
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

    return res.json({ ok: true, device: rows[0] || null });
  } catch (err) {
    console.error("[admin/devices/update] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/activate] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/suspend] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  POST /v1/admin/devices/:code/upstream
 *  body: { upstream_base_url, username, password }
 *  - stores encrypted upstream creds per device
 *  ========================================= */
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
    console.error("[admin/upstream] error:", err);
    return res.status(500).json({ error: "internal error" });
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
    console.error("[admin/delete] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
