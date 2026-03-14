const { Router } = require("express");
const { pool } = require("../db/pool.cjs");
const { authJwt } = require("../middleware/authJwt.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

router.get("/home-ads", authJwt, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `
      SELECT
        id,
        slot_key,
        title,
        poster_url,
        media_type,
        media_url,
        is_active,
        starts_at,
        ends_at,
        updated_at
      FROM app_home_ads
      WHERE is_active=1
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at IS NULL OR ends_at >= NOW())
      ORDER BY FIELD(slot_key, 'home_left', 'home_right', 'movies', 'series'), id ASC
      `
    );
    return res.json({ ads: rows });
  } catch (err) {
    if (String(err?.code || "") === "ER_NO_SUCH_TABLE") {
      return res.json({ ads: [] });
    }
    return sendInternalError(req, res, "home-ads/list", err);
  }
});

module.exports = router;
