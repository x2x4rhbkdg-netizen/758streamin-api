/** =========================================
 *  ROUTES: Playback tokens (JWT required) (CommonJS)
 *  ========================================= */
const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { authJwt } = require("../middleware/authJwt.cjs");
const { env } = require("../config/env.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const { buildUrl, buildXuiPlayerApiUrl } = require("../utils/xui.cjs");
const { pool } = require("../db/pool.cjs");

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

function normalizeLiveOutput(v) {
  const out = String(v || "m3u8").trim().toLowerCase();
  return out === "ts" ? "ts" : "m3u8";
}

function normalizeSourceMode(v) {
  const mode = String(v || "auto").trim().toLowerCase();
  return ["path", "auto", "stream_source"].includes(mode) ? mode : "auto";
}

function parseFirstHttpUrl(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = parseFirstHttpUrl(entry);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim();
  if (!raw) return null;

  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      const parsed = JSON.parse(raw);
      return parseFirstHttpUrl(parsed);
    } catch {
      // keep checking raw string below
    }
  }

  if (/^https?:\/\//i.test(raw)) return raw;
  return null;
}

async function fetchXuiJson(upstream, action, params = {}) {
  const base = buildXuiPlayerApiUrl({
    upstream_base_url: upstream.upstream_base_url,
    username: upstream.username,
    password: upstream.password,
  });

  const url = new URL(base);
  if (action) url.searchParams.set("action", action);
  Object.entries(params).forEach(([k, val]) => {
    if (val === undefined || val === null || val === "") return;
    url.searchParams.set(k, String(val));
  });

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "User-Agent": "streamin-api/1.0" },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const err = new Error("upstream failed");
    err.status = resp.status;
    err.body = txt.slice(0, 200);
    throw err;
  }

  const txt = await resp.text();
  try {
    return JSON.parse(txt);
  } catch {
    const err = new Error("upstream returned invalid JSON");
    err.status = 502;
    err.body = txt.slice(0, 200);
    throw err;
  }
}

async function resolveLiveDirectSource(upstream, streamId) {
  if (!streamId) return null;
  const streams = await fetchXuiJson(upstream, "get_live_streams");
  const list = Array.isArray(streams) ? streams : [];
  const wanted = String(streamId);
  const match = list.find((item) => String(item?.stream_id || "") === wanted);
  if (!match) return null;

  const candidates = [
    match?.stream_source,
    match?.direct_source,
    match?.source,
    match?.stream_url,
    match?.url,
  ];

  for (const candidate of candidates) {
    const direct = parseFirstHttpUrl(candidate);
    if (direct) return direct;
  }

  return null;
}

function buildStreamUrl({ upstream, type, streamId, episodeId, format, liveHlsOutput }) {
  const fmt = String(format || "hls").toLowerCase();
  const ext = fmt === "dash"
    ? "mpd"
    : (type === "live" ? normalizeLiveOutput(liveHlsOutput) : "m3u8");
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

    const [rows] = await pool.execute(
      `SELECT d.status, a.expires_at
       FROM devices d
       LEFT JOIN device_access a ON a.device_id = d.id
       WHERE d.id=?
       LIMIT 1`,
      [payload.device_id]
    );
    const dev = rows[0];
    if (!dev) return res.status(401).json({ error: "device not found" });
    if (dev.status !== "active") return res.status(403).json({ error: "device not active" });
    if (dev.expires_at) {
      const exp = new Date(dev.expires_at).getTime();
      if (!Number.isNaN(exp) && exp < Date.now()) {
        return res.status(403).json({ error: "device expired" });
      }
    }

    const upstream = await getDeviceUpstream(payload.device_id);
    if (!upstream) return res.status(404).json({ error: "no upstream configured for device" });

    const format = String(req.query.format || "hls").trim().toLowerCase();
    const sourceMode = normalizeSourceMode(env.LIVE_SOURCE_MODE);

    if (payload.type === "live" && sourceMode !== "path") {
      try {
        const direct = await resolveLiveDirectSource(upstream, payload.stream_id);
        if (direct) {
          res.setHeader("Cache-Control", "no-store");
          return res.redirect(302, direct);
        }
      } catch (err) {
        console.warn("[playback/stream] live source lookup failed:", err?.message || err);
      }

      if (sourceMode === "stream_source") {
        return res.status(502).json({ error: "live stream source unavailable" });
      }
    }

    const url = buildStreamUrl({
      upstream,
      type: payload.type,
      streamId: payload.stream_id,
      episodeId: payload.episode_id,
      format,
      liveHlsOutput: env.LIVE_HLS_OUTPUT,
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
