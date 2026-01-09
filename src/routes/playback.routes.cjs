/** =========================================
 *  ROUTES: Playback tokens (JWT required) (CommonJS)
 *  ========================================= */
const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { authJwt } = require("../middleware/authJwt.cjs");
const { env } = require("../config/env.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const { buildUrl } = require("../utils/xui.cjs");

const router = Router();

const PLAYBACK_AUD = "playback";
const PLAYBACK_ISS = "streamin-api";

function parseTtl(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(60, Math.min(24 * 3600, n));
}

function normalizeBaseUrl(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

function buildStreamUrl({ upstream, type, streamId, episodeId, format }) {
  const fmt = String(format || "hls").toLowerCase();
  const ext = fmt === "dash" ? "mpd" : "m3u8";
  const user = encodeURIComponent(upstream.username);
  const pass = encodeURIComponent(upstream.password);

  let path = "";
  if (type === "live") path = `/live/${user}/${pass}/${streamId}.${ext}`;
  if (type === "vod") path = `/movie/${user}/${pass}/${streamId}.${ext}`;
  if (type === "series") path = `/series/${user}/${pass}/${episodeId}.${ext}`;

  if (!path) throw new Error("invalid stream type");
  return buildUrl(upstream.upstream_base_url, path);
}

function buildPlaybackLink(baseUrl, token, format) {
  const base = normalizeBaseUrl(baseUrl);
  const prefix = base ? `${base}/v1/playback/stream` : "/v1/playback/stream";
  return `${prefix}?token=${encodeURIComponent(token)}&format=${encodeURIComponent(format)}`;
}

/** =========================================
 *  POST /v1/playback/token
 *  body: { type, stream_id, episode_id?, ttl_sec? }
 *  ========================================= */
router.post("/playback/token", authJwt, async (req, res) => {
  try {
    const type = String(req.body?.type || "").trim().toLowerCase();
    const streamId = String(req.body?.stream_id || "").trim();
    const episodeId = String(req.body?.episode_id || "").trim();

    if (!type) return res.status(400).json({ error: "type required" });

    if (!["live", "vod", "series"].includes(type)) {
      return res.status(400).json({ error: "invalid type" });
    }

    if (type === "series" && !episodeId) {
      return res.status(400).json({ error: "episode_id required for series" });
    }
    if (type !== "series" && !streamId) {
      return res.status(400).json({ error: "stream_id required" });
    }

    const ttlSec = parseTtl(req.body?.ttl_sec, Number(env.PLAYBACK_TOKEN_TTL || 3600));

    const token = jwt.sign(
      {
        device_id: req.device.device_id,
        type,
        stream_id: streamId || null,
        episode_id: episodeId || null,
      },
      env.JWT_SECRET,
      {
        expiresIn: ttlSec,
        audience: PLAYBACK_AUD,
        issuer: PLAYBACK_ISS,
      }
    );

    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    const baseUrl = env.PLAYBACK_BASE_URL || "";

    return res.json({
      token,
      expires_at: expiresAt,
      urls: {
        hls: buildPlaybackLink(baseUrl, token, "hls"),
        dash: buildPlaybackLink(baseUrl, token, "dash"),
      },
    });
  } catch (err) {
    console.error("[playback/token] error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

/** =========================================
 *  GET /v1/playback/stream?token=...&format=hls|dash
 *  - verifies token and redirects to upstream stream URL
 *  ========================================= */
router.get("/playback/stream", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ error: "token required" });

    const payload = jwt.verify(token, env.JWT_SECRET, {
      audience: PLAYBACK_AUD,
      issuer: PLAYBACK_ISS,
    });

    const upstream = await getDeviceUpstream(payload.device_id);
    if (!upstream) return res.status(404).json({ error: "no upstream configured for device" });

    const format = String(req.query.format || "hls").trim().toLowerCase();

    const url = buildStreamUrl({
      upstream,
      type: payload.type,
      streamId: payload.stream_id,
      episodeId: payload.episode_id,
      format,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url);
  } catch (err) {
    if (err?.message === "missing upstream base URL") {
      return res.status(500).json({ error: "missing upstream base URL" });
    }
    if (err?.message === "invalid stream type") {
      return res.status(400).json({ error: "invalid stream type" });
    }
    console.error("[playback/stream] error:", err);
    return res.status(401).json({ error: "invalid token" });
  }
});

module.exports = router;
