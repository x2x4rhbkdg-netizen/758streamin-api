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

router.get("/notifications", authJwt, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, toInt(req.query.limit, 50)));
    const deviceId = Number(req.device.device_id);

    let platform = normPlatform(req.query.platform);
    if (!platform) {
      const [rows] = await pool.execute(
        `SELECT platform FROM devices WHERE id=? LIMIT 1`,
        [deviceId]
      );
      platform = normPlatform(rows[0]?.platform || "");
    }

    const alias = derivePlatformAlias(platform);

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
        n.target_scope,
        n.target_platform,
        n.starts_at,
        n.ends_at,
        n.created_at,
        n.updated_at
      FROM app_notifications n
      WHERE n.status='active'
        AND (n.starts_at IS NULL OR n.starts_at <= NOW())
        AND (n.ends_at IS NULL OR n.ends_at >= NOW())
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
      notifications: rows,
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
