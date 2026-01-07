/** =========================================
 *  ROUTES: Playlist proxy (JWT required) (CommonJS) - MySQL
 *  ========================================= */
const { Router } = require("express");
const { authJwt } = require("../middleware/authJwt.cjs");
const { pool } = require("../db/pool.cjs");
const { decryptString } = require("../utils/cryptoVault.cjs");
const { buildXuiM3uUrl } = require("../utils/xui.cjs");

const router = Router();

/** =========================================
 *  GET /v1/playlist.m3u8
 *  - Proxies upstream playlist using server-side creds
 *  ========================================= */
router.get("/playlist.m3u8", authJwt, async (req, res) => {
  try {
    const deviceId = req.device.device_id;

    const [rows] = await pool.execute(
      `SELECT upstream_base_url, enc_username, enc_password
       FROM device_upstream
       WHERE device_id=?
       LIMIT 1`,
      [deviceId]
    );

    const row = rows[0];
    if (!row) return res.status(404).json({ error: "no upstream configured for device" });

    const username = decryptString(row.enc_username);
    const password = decryptString(row.enc_password);

    const upstreamUrl = buildXuiM3uUrl({
      upstream_base_url: row.upstream_base_url,
      username,
      password,
    });

    // Node 18+ has global fetch
    const upstreamResp = await fetch(upstreamUrl, {
      method: "GET",
      headers: { "User-Agent": "streamin-api/1.0" },
    });

    if (!upstreamResp.ok) {
      const txt = await upstreamResp.text().catch(() => "");
      return res.status(502).json({
        error: "upstream failed",
        status: upstreamResp.status,
        body: txt.slice(0, 200),
      });
    }

    const m3u = await upstreamResp.text();

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(m3u);
  } catch (err) {
    console.error("[playlist] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;