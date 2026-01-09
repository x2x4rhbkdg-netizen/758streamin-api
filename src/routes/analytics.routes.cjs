/** =========================================
 *  ROUTES: Analytics events (JWT required) (CommonJS)
 *  ========================================= */
const { Router } = require("express");
const { authJwt } = require("../middleware/authJwt.cjs");
const { pool } = require("../db/pool.cjs");

const router = Router();

function normStr(v, max = 64) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** =========================================
 *  POST /v1/analytics/event
 *  body: { event_type, content_id?, content_type?, position_seconds?, duration_seconds?, error_code?, meta? }
 *  ========================================= */
router.post("/analytics/event", authJwt, async (req, res) => {
  try {
    const eventType = normStr(req.body?.event_type, 32).toLowerCase();
    const contentId = normStr(req.body?.content_id, 64) || null;
    const contentType = normStr(req.body?.content_type, 16).toLowerCase() || null;
    const positionSeconds = numOrNull(req.body?.position_seconds);
    const durationSeconds = numOrNull(req.body?.duration_seconds);
    const errorCode = normStr(req.body?.error_code, 64) || null;

    const meta = req.body?.meta ?? null;
    const metaJson = meta ? JSON.stringify(meta).slice(0, 8000) : null;

    if (!eventType) return res.status(400).json({ error: "event_type required" });

    const [result] = await pool.execute(
      `INSERT INTO analytics_events
        (device_id, event_type, content_id, content_type, position_seconds, duration_seconds, error_code, meta_json, created_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        req.device.device_id,
        eventType,
        contentId,
        contentType,
        positionSeconds,
        durationSeconds,
        errorCode,
        metaJson,
      ]
    );

    return res.json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error("[analytics/event] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
