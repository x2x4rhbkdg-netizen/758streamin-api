const { Router } = require("express");
const { pool } = require("../db/pool.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

function normStr(v, max = 120) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function normChannel(v) {
  const ch = String(v || "direct").trim().toLowerCase();
  return ["direct", "play", "amazon"].includes(ch) ? ch : "direct";
}

function normPlatform(v) {
  const p = String(v || "").trim().toLowerCase();
  if (!p) return "";
  if (["android_tv", "android_mobile", "all"].includes(p)) return p;
  return p.length > 32 ? p.slice(0, 32) : p;
}

async function handleCheck(req, res) {
  try {
    const channel = normChannel(req.body?.channel);
    const platform = normPlatform(req.body?.platform);
    const currentVersionCode = toInt(req.body?.version_code);

    const params = [channel];
    let where = `WHERE status='active' AND channel=?`;
    if (platform) {
      where += ` AND (platform=? OR platform='all')`;
      params.push(platform);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        channel,
        platform,
        version_code,
        version_name,
        apk_url,
        sha256,
        force_update,
        notes,
        updated_at
      FROM app_updates
      ${where}
      ORDER BY version_code DESC, updated_at DESC
      LIMIT 1
      `,
      params
    );

    const row = rows[0];
    if (!row) {
      return res.json({ available: false });
    }

    const latestCode = Number(row.version_code || 0);
    const currentCode = Number.isFinite(currentVersionCode) ? currentVersionCode : null;
    const available = currentCode === null ? true : latestCode > currentCode;

    return res.json({
      available,
      latest_version_code: latestCode,
      latest_version_name: row.version_name || null,
      apk_url: row.apk_url,
      sha256: row.sha256 || null,
      force: available,
      message: row.notes || null,
      channel: row.channel,
      platform: row.platform,
    });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ available: false });
    }
    return sendInternalError(req, res, "app/update/check", err);
  }
}

router.post("/app/update/check", handleCheck);
router.post("/app/update", handleCheck);

module.exports = router;
