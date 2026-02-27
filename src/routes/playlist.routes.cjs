/** =========================================
 *  ROUTES: Playlist proxy (JWT required) (CommonJS) - MySQL
 *  ========================================= */
const { Router } = require("express");
const { authJwt } = require("../middleware/authJwt.cjs");
const { env } = require("../config/env.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const { buildXuiM3uUrls, fetchTextWithFallback } = require("../utils/xui.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

/** =========================================
 *  GET /v1/playlist.m3u8
 *  - Proxies upstream playlist using server-side creds
 *  ========================================= */
router.get("/playlist.m3u8", authJwt, async (req, res) => {
  try {
    const upstream = await getDeviceUpstream(req.device.device_id);
    if (!upstream) return res.status(404).json({ error: "no upstream configured for device" });

    const upstreamUrls = buildXuiM3uUrls({
      upstream_base_url: upstream.upstream_base_url,
      username: upstream.username,
      password: upstream.password,
    }, { allowHttpFallback: env.XUI_HTTP_FALLBACK });

    const m3u = await fetchTextWithFallback(
      upstreamUrls,
      { method: "GET", headers: { "User-Agent": "streamin-api/1.0" } },
      { timeoutMs: env.XUI_REQUEST_TIMEOUT_MS }
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(m3u);
  } catch (err) {
    if (err?.message === "missing upstream base URL") {
      return res.status(500).json({ error: "missing upstream base URL" });
    }
    return sendInternalError(req, res, "playlist", err);
  }
});

module.exports = router;
