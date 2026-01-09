/** =========================================
 *  ROUTES: Playlist proxy (JWT required) (CommonJS) - MySQL
 *  ========================================= */
const { Router } = require("express");
const { authJwt } = require("../middleware/authJwt.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const { buildXuiM3uUrl } = require("../utils/xui.cjs");

const router = Router();

/** =========================================
 *  GET /v1/playlist.m3u8
 *  - Proxies upstream playlist using server-side creds
 *  ========================================= */
router.get("/playlist.m3u8", authJwt, async (req, res) => {
  try {
    const upstream = await getDeviceUpstream(req.device.device_id);
    if (!upstream) return res.status(404).json({ error: "no upstream configured for device" });

    const upstreamUrl = buildXuiM3uUrl({
      upstream_base_url: upstream.upstream_base_url,
      username: upstream.username,
      password: upstream.password,
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
    if (err?.message === "missing upstream base URL") {
      return res.status(500).json({ error: "missing upstream base URL" });
    }
    console.error("[playlist] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
