/** =========================================
 *  ROUTES: Playback tokens (JWT required) (CommonJS)
 *  ========================================= */
const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { authJwt } = require("../middleware/authJwt.cjs");
const { env } = require("../config/env.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const {
  buildUrl,
  buildUrlCandidates,
  buildXuiPlayerApiUrls,
  fetchJsonWithFallback,
} = require("../utils/xui.cjs");
const { pool } = require("../db/pool.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

const PLAYBACK_AUD = "playback";
const PLAYBACK_ISS = "streamin-api";

const playbackTokenCache = new Map();
const PLAYBACK_TOKEN_CACHE_MAX = 2000;
const TOKEN_REUSE_SAFETY_SEC = Math.max(
  5,
  Math.min(600, Number(env.PLAYBACK_TOKEN_REUSE_SAFETY_SEC || 30) || 30)
);
const embeddedHlsVariantCache = new Map();
const EMBEDDED_HLS_VARIANT_CACHE_MAX = 500;
const EMBEDDED_HLS_VARIANT_CACHE_TTL_MS = Math.max(
  5000,
  Math.min(10 * 60 * 1000, Number(process.env.SAMSUNG_EMBEDDED_HLS_VARIANT_CACHE_TTL_MS || 60 * 1000) || 60 * 1000)
);
const EMBEDDED_HLS_MAX_DEPTH = 3;
const SAMSUNG_HLS_MAX_BITRATE = Math.max(
  250000,
  Math.min(10 * 1000 * 1000, Number(process.env.SAMSUNG_HLS_MAX_BITRATE || 2000000) || 2000000)
);
const SAMSUNG_HLS_MAX_WIDTH = Math.max(
  320,
  Math.min(3840, Number(process.env.SAMSUNG_HLS_MAX_WIDTH || 1280) || 1280)
);
const SAMSUNG_HLS_MAX_HEIGHT = Math.max(
  180,
  Math.min(2160, Number(process.env.SAMSUNG_HLS_MAX_HEIGHT || 720) || 720)
);

function parseTtl(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(60, Math.min(24 * 3600, n));
}

function tokenCacheKey({ deviceId, type, streamId, episodeId }) {
  return [
    String(deviceId || ""),
    String(type || ""),
    String(streamId || ""),
    String(episodeId || ""),
  ].join("|");
}

function prunePlaybackTokenCache(nowMs = Date.now()) {
  if (!playbackTokenCache.size) return;

  for (const [key, value] of playbackTokenCache.entries()) {
    if (!value || Number(value.expiresAtMs || 0) <= nowMs) {
      playbackTokenCache.delete(key);
    }
  }

  if (playbackTokenCache.size <= PLAYBACK_TOKEN_CACHE_MAX) return;

  const entries = Array.from(playbackTokenCache.entries()).sort(
    (a, b) => Number(a[1]?.touchedAt || 0) - Number(b[1]?.touchedAt || 0)
  );
  const removeCount = playbackTokenCache.size - PLAYBACK_TOKEN_CACHE_MAX;
  for (let i = 0; i < removeCount; i += 1) {
    const key = entries[i]?.[0];
    if (key) playbackTokenCache.delete(key);
  }
}

function getCachedPlaybackToken(key, minRemainingSec = TOKEN_REUSE_SAFETY_SEC) {
  const entry = playbackTokenCache.get(key);
  if (!entry) return null;

  const nowMs = Date.now();
  if (Number(entry.expiresAtMs || 0) <= nowMs + Math.max(1, Number(minRemainingSec || 0)) * 1000) {
    playbackTokenCache.delete(key);
    return null;
  }

  entry.touchedAt = nowMs;
  return entry;
}

function setCachedPlaybackToken(key, token, expiresAtMs) {
  playbackTokenCache.set(key, {
    token,
    expiresAtMs,
    touchedAt: Date.now(),
  });
  prunePlaybackTokenCache();
}

function pruneEmbeddedHlsVariantCache(nowMs = Date.now()) {
  if (!embeddedHlsVariantCache.size) return;

  for (const [key, value] of embeddedHlsVariantCache.entries()) {
    if (!value || Number(value.expiresAtMs || 0) <= nowMs) {
      embeddedHlsVariantCache.delete(key);
    }
  }

  if (embeddedHlsVariantCache.size <= EMBEDDED_HLS_VARIANT_CACHE_MAX) return;

  const entries = Array.from(embeddedHlsVariantCache.entries()).sort(
    (a, b) => Number(a[1]?.touchedAt || 0) - Number(b[1]?.touchedAt || 0)
  );
  const removeCount = embeddedHlsVariantCache.size - EMBEDDED_HLS_VARIANT_CACHE_MAX;
  for (let i = 0; i < removeCount; i += 1) {
    const key = entries[i]?.[0];
    if (key) embeddedHlsVariantCache.delete(key);
  }
}

function getCachedEmbeddedHlsVariant(url) {
  const key = String(url || "").trim();
  if (!key) return "";

  const entry = embeddedHlsVariantCache.get(key);
  if (!entry) return "";

  if (Number(entry.expiresAtMs || 0) <= Date.now()) {
    embeddedHlsVariantCache.delete(key);
    return "";
  }

  entry.touchedAt = Date.now();
  return String(entry.url || "");
}

function setCachedEmbeddedHlsVariant(url, selectedUrl) {
  const key = String(url || "").trim();
  const value = String(selectedUrl || "").trim();
  if (!key || !value) return;

  embeddedHlsVariantCache.set(key, {
    url: value,
    expiresAtMs: Date.now() + EMBEDDED_HLS_VARIANT_CACHE_TTL_MS,
    touchedAt: Date.now(),
  });
  pruneEmbeddedHlsVariantCache();
}

function deleteCachedEmbeddedHlsVariant(url) {
  const key = String(url || "").trim();
  if (!key) return;
  embeddedHlsVariantCache.delete(key);
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

function normalizePlatform(v) {
  return String(v || "").trim().toLowerCase();
}

function needsEmbeddedHlsManifest(platform) {
  const value = normalizePlatform(platform);
  return value === "samsung" || value === "samsung_tizen_web";
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

function isLikelyHlsUrl(value) {
  const raw = String(value || "").toLowerCase();
  if (!raw) return false;
  if (raw.includes(".m3u8")) return true;
  return /[?&](output|type|format)=(m3u8|hls)\b/.test(raw);
}

function isLikelyMpegTsUrl(value) {
  const raw = String(value || "").toLowerCase();
  if (!raw) return false;
  if (raw.includes(".ts")) return true;
  return /[?&](output|type|format)=ts\b/.test(raw);
}

function isLikelyDashUrl(value) {
  const raw = String(value || "").toLowerCase();
  if (!raw) return false;
  if (raw.includes(".mpd")) return true;
  return /[?&](type|format)=dash\b/.test(raw);
}

function isWebPlayableLiveSource(url, format) {
  if (!/^https?:\/\//i.test(String(url || ""))) return false;
  const fmt = String(format || "hls").trim().toLowerCase();
  if (fmt === "dash") return isLikelyDashUrl(url);
  // HLS players on TVs usually accept .m3u8 and some also accept MPEG-TS .ts.
  return isLikelyHlsUrl(url) || isLikelyMpegTsUrl(url);
}

async function fetchXuiJson(upstream, action, params = {}) {
  const urls = buildXuiPlayerApiUrls({
    upstream_base_url: upstream.upstream_base_url,
    username: upstream.username,
    password: upstream.password,
  }, { allowHttpFallback: env.XUI_HTTP_FALLBACK });

  const actionParams = {};
  if (action) actionParams.action = action;
  Object.entries(params).forEach(([k, val]) => {
    if (val === undefined || val === null || val === "") return;
    actionParams[k] = val;
  });

  const requestUrls = (urls || []).map((u) => {
    const url = new URL(u);
    Object.entries(actionParams).forEach(([k, val]) => {
      url.searchParams.set(k, String(val));
    });
    return url.toString();
  });

  return fetchJsonWithFallback(
    requestUrls,
    { method: "GET", headers: { "User-Agent": "streamin-api/1.0" } },
    { timeoutMs: env.XUI_REQUEST_TIMEOUT_MS }
  );
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

function buildStreamUrl({
  upstream,
  type,
  streamId,
  episodeId,
  format,
  liveHlsOutput,
  allowHttpFallback = true,
}) {
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
  return buildUrl(upstream.upstream_base_url, path, {}, { allowHttpFallback });
}

function buildStreamUrls({
  upstream,
  type,
  streamId,
  episodeId,
  format,
  liveHlsOutput,
  allowHttpFallback = true,
}) {
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
  return buildUrlCandidates(upstream.upstream_base_url, path, {}, { allowHttpFallback });
}

function buildPlaybackLink(baseUrl, token, format) {
  const base = normalizeBaseUrl(baseUrl);
  const prefix = base ? `${base}/v1/playback/stream` : "/v1/playback/stream";
  return `${prefix}?token=${encodeURIComponent(token)}&format=${encodeURIComponent(format)}`;
}

function buildEmbeddedHlsLink(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl);
  const prefix = base ? `${base}/v1/playback/embedded-hls` : "/v1/playback/embedded-hls";
  return `${prefix}?token=${encodeURIComponent(token)}`;
}

function absolutizeManifestUri(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  if (/^(data:|https?:\/\/)/i.test(raw)) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function rewriteManifestLine(line, baseUrl, mapUri) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return line;

  const applyUri = (uri) => {
    const absolute = absolutizeManifestUri(uri, baseUrl);
    return typeof mapUri === "function" ? mapUri(absolute) : absolute;
  };

  if (trimmed.startsWith("#")) {
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${applyUri(uri)}"`);
  }

  return applyUri(trimmed);
}

function rewriteM3uManifest(text, baseUrl, mapUri) {
  const raw = String(text || "");
  if (!raw.trim()) return raw;
  return raw
    .split(/\r?\n/)
    .map((line) => rewriteManifestLine(line, baseUrl, mapUri))
    .join("\n");
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isM3uManifest(urlValue, contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("application/vnd.apple.mpegurl")) return true;
  if (type.includes("application/x-mpegurl")) return true;
  if (type.includes("audio/mpegurl")) return true;
  const url = String(urlValue || "").toLowerCase();
  return url.includes(".m3u8") || /[?&](format|output|type)=(m3u8|hls)\b/.test(url);
}

function inferContentType(urlValue, fallback = "application/octet-stream") {
  const url = String(urlValue || "").toLowerCase();
  if (url.includes(".m3u8")) return "application/vnd.apple.mpegurl; charset=utf-8";
  if (url.includes(".ts")) return "video/mp2t";
  if (url.includes(".m4s")) return "video/iso.segment";
  if (url.includes(".mp4")) return "video/mp4";
  if (url.includes(".aac")) return "audio/aac";
  if (url.includes(".key")) return "application/octet-stream";
  return fallback;
}

function isMasterM3uManifest(text) {
  return /#EXT-X-STREAM-INF:/i.test(String(text || ""));
}

function parseHlsAttributeList(line) {
  const raw = String(line || "");
  const out = {};
  const body = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  let match = pattern.exec(body);
  while (match) {
    const key = String(match[1] || "").trim().toUpperCase();
    let value = String(match[2] || "").trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
    match = pattern.exec(body);
  }
  return out;
}

function parseResolution(value) {
  const match = String(value || "").trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return { width: 0, height: 0 };
  return {
    width: Number(match[1] || 0) || 0,
    height: Number(match[2] || 0) || 0,
  };
}

function getVariantBandwidth(variant) {
  return Number(variant?.averageBandwidth || variant?.bandwidth || 0) || 0;
}

function parseMasterManifestVariants(text, baseUrl) {
  const lines = String(text || "").split(/\r?\n/);
  const variants = [];
  let pendingAttributes = null;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) {
      pendingAttributes = parseHlsAttributeList(trimmed);
      continue;
    }

    if (trimmed.startsWith("#")) continue;
    if (!pendingAttributes) continue;

    const absoluteUrl = absolutizeManifestUri(trimmed, baseUrl);
    const resolution = parseResolution(pendingAttributes.RESOLUTION);
    variants.push({
      url: absoluteUrl,
      bandwidth: Number(pendingAttributes.BANDWIDTH || 0) || 0,
      averageBandwidth: Number(pendingAttributes["AVERAGE-BANDWIDTH"] || 0) || 0,
      width: resolution.width,
      height: resolution.height,
      codecs: String(pendingAttributes.CODECS || ""),
      name: String(pendingAttributes.NAME || ""),
    });
    pendingAttributes = null;
  }

  return variants.filter((variant) => isHttpUrl(variant.url));
}

function pickSamsungStableVariant(variants) {
  const list = Array.isArray(variants) ? variants.filter(Boolean) : [];
  if (!list.length) return null;

  const videoVariants = list.filter((variant) => Number(variant.width || 0) > 0 || Number(variant.height || 0) > 0);
  const pool = videoVariants.length ? videoVariants : list;
  const withinCaps = pool.filter((variant) => {
    const bandwidth = getVariantBandwidth(variant);
    const width = Number(variant.width || 0);
    const height = Number(variant.height || 0);
    return (
      (!bandwidth || bandwidth <= SAMSUNG_HLS_MAX_BITRATE) &&
      (!width || width <= SAMSUNG_HLS_MAX_WIDTH) &&
      (!height || height <= SAMSUNG_HLS_MAX_HEIGHT)
    );
  });

  const candidates = withinCaps.length ? withinCaps : pool;
  const sorted = [...candidates].sort((left, right) => {
    const leftBandwidth = getVariantBandwidth(left);
    const rightBandwidth = getVariantBandwidth(right);
    const leftArea = Number(left.width || 0) * Number(left.height || 0);
    const rightArea = Number(right.width || 0) * Number(right.height || 0);

    if (withinCaps.length) {
      if (rightBandwidth !== leftBandwidth) return rightBandwidth - leftBandwidth;
      if (rightArea !== leftArea) return rightArea - leftArea;
      return String(right.url || "").localeCompare(String(left.url || ""));
    }

    const normalizedLeftBandwidth = leftBandwidth > 0 ? leftBandwidth : Number.MAX_SAFE_INTEGER;
    const normalizedRightBandwidth = rightBandwidth > 0 ? rightBandwidth : Number.MAX_SAFE_INTEGER;
    if (normalizedLeftBandwidth !== normalizedRightBandwidth) {
      return normalizedLeftBandwidth - normalizedRightBandwidth;
    }
    const normalizedLeftArea = leftArea > 0 ? leftArea : Number.MAX_SAFE_INTEGER;
    const normalizedRightArea = rightArea > 0 ? rightArea : Number.MAX_SAFE_INTEGER;
    if (normalizedLeftArea !== normalizedRightArea) {
      return normalizedLeftArea - normalizedRightArea;
    }
    return String(left.url || "").localeCompare(String(right.url || ""));
  });

  return sorted[0] || null;
}

async function fetchTextWithResolvedUrl(urls, init = {}, options = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (!list.length) throw new Error("No upstream URL candidates");

  const timeoutMs = Number(options.timeoutMs || 0);
  let lastErr = null;

  for (let i = 0; i < list.length; i += 1) {
    const targetUrl = list[i];
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(targetUrl, {
        ...init,
        redirect: "follow",
        signal: controller?.signal || init.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        const err = new Error("upstream failed");
        err.status = response.status;
        err.url = targetUrl;
        err.body = text.slice(0, 200);
        lastErr = err;
        if (i < list.length - 1 && response.status >= 500) continue;
        throw err;
      }

      return {
        text,
        url: String(response.url || targetUrl),
        contentType: String(response.headers.get("content-type") || ""),
      };
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      if (i < list.length - 1 && (!status || status >= 500)) continue;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastErr || new Error("upstream failed");
}

async function fetchBinaryWithResolvedUrl(url, init = {}, options = {}) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) throw new Error("No upstream URL candidate");

  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(targetUrl, {
      ...init,
      redirect: "follow",
      signal: controller?.signal || init.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const err = new Error("upstream failed");
      err.status = response.status;
      err.url = targetUrl;
      err.body = bodyText.slice(0, 200);
      throw err;
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      url: String(response.url || targetUrl),
      contentType: String(response.headers.get("content-type") || ""),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveEmbeddedSamsungManifest(urls) {
  const requestInit = {
    method: "GET",
    headers: { "User-Agent": "streamin-api/1.0" },
  };
  const requestOptions = {
    timeoutMs: env.XUI_REQUEST_TIMEOUT_MS,
  };

  let manifest = await fetchTextWithResolvedUrl(urls, requestInit, requestOptions);

  for (let depth = 0; depth < EMBEDDED_HLS_MAX_DEPTH; depth += 1) {
    const manifestText = String(manifest.text || "");
    if (!manifestText.trim()) {
      const err = new Error("upstream returned empty manifest");
      err.status = 502;
      throw err;
    }

    if (!isMasterM3uManifest(manifestText)) {
      return manifest;
    }

    const parentUrl = String(manifest.url || "");
    let selectedUrl = getCachedEmbeddedHlsVariant(parentUrl);

    if (!selectedUrl) {
      const variants = parseMasterManifestVariants(manifestText, parentUrl);
      const selectedVariant = pickSamsungStableVariant(variants);
      selectedUrl = String(selectedVariant?.url || "");
      if (!selectedUrl) {
        return manifest;
      }
      setCachedEmbeddedHlsVariant(parentUrl, selectedUrl);
    }

    try {
      manifest = await fetchTextWithResolvedUrl([selectedUrl], requestInit, requestOptions);
    } catch (err) {
      deleteCachedEmbeddedHlsVariant(parentUrl);
      console.warn("[playback/embedded-hls] stable variant fetch failed:", err?.message || err);
      return {
        text: manifestText,
        url: parentUrl,
        contentType: String(manifest.contentType || ""),
      };
    }
  }

  return manifest;
}

async function resolvePlaybackContext(token) {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    audience: PLAYBACK_AUD,
    issuer: PLAYBACK_ISS,
  });

  const [rows] = await pool.execute(
    `SELECT d.status, d.platform, a.expires_at
     FROM devices d
     LEFT JOIN device_access a ON a.device_id = d.id
     WHERE d.id=?
     LIMIT 1`,
    [payload.device_id]
  );
  const device = rows[0];
  if (!device) {
    const err = new Error("device not found");
    err.status = 401;
    throw err;
  }
  if (device.status !== "active") {
    const err = new Error("device not active");
    err.status = 403;
    throw err;
  }
  if (device.expires_at) {
    const exp = new Date(device.expires_at).getTime();
    if (!Number.isNaN(exp) && exp < Date.now()) {
      const err = new Error("device expired");
      err.status = 403;
      throw err;
    }
  }

  const upstream = await getDeviceUpstream(payload.device_id);
  if (!upstream) {
    const err = new Error("no upstream configured for device");
    err.status = 404;
    throw err;
  }

  return { payload, device, upstream };
}

async function resolveLivePlaybackCandidates(upstream, payload, format) {
  const sourceMode = normalizeSourceMode(env.LIVE_SOURCE_MODE);

  if (payload.type === "live" && sourceMode !== "path") {
    let sawDirect = false;
    let usedDirect = false;

    try {
      const direct = await resolveLiveDirectSource(upstream, payload.stream_id);
      if (direct) {
        sawDirect = true;
        if (isWebPlayableLiveSource(direct, format)) {
          usedDirect = true;
          return { urls: [direct], sourceMode, sawDirect, usedDirect };
        }

        console.warn("[playback/stream] skipping non-web-playable direct source:", direct);
      }
    } catch (err) {
      console.warn("[playback/stream] live source lookup failed:", err?.message || err);
    }

    if (sourceMode === "stream_source") {
      const reason = sawDirect && !usedDirect
        ? "live stream source unsupported for web playback"
        : "live stream source unavailable";
      const err = new Error(reason);
      err.status = 502;
      throw err;
    }
  }

  return {
    urls: buildStreamUrls({
      upstream,
      type: payload.type,
      streamId: payload.stream_id,
      episodeId: payload.episode_id,
      format,
      liveHlsOutput: env.LIVE_HLS_OUTPUT,
      allowHttpFallback: env.XUI_HTTP_FALLBACK,
    }),
    sourceMode,
    sawDirect: false,
    usedDirect: false,
  };
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

    const cacheKey = tokenCacheKey({
      deviceId: req.device.device_id,
      type,
      streamId: streamId || null,
      episodeId: episodeId || null,
    });

    const cached = getCachedPlaybackToken(
      cacheKey,
      Math.min(TOKEN_REUSE_SAFETY_SEC, Math.max(5, Math.floor(ttlSec / 6)))
    );

    const baseUrl = env.PLAYBACK_BASE_URL || "";

    if (cached) {
      const expiresAt = new Date(cached.expiresAtMs).toISOString();
      return res.json({
        token: cached.token,
        expires_at: expiresAt,
        urls: {
          hls: buildPlaybackLink(baseUrl, cached.token, "hls"),
          dash: buildPlaybackLink(baseUrl, cached.token, "dash"),
        },
      });
    }

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

    const expiresAtMs = Date.now() + ttlSec * 1000;
    setCachedPlaybackToken(cacheKey, token, expiresAtMs);

    const expiresAt = new Date(expiresAtMs).toISOString();

    return res.json({
      token,
      expires_at: expiresAt,
      urls: {
        hls: buildPlaybackLink(baseUrl, token, "hls"),
        dash: buildPlaybackLink(baseUrl, token, "dash"),
      },
    });
  } catch (err) {
    return sendInternalError(req, res, "playback/token", err);
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

    const { payload, device, upstream } = await resolvePlaybackContext(token);

    const format = String(req.query.format || "hls").trim().toLowerCase();
    if (payload.type === "live" && format === "hls" && needsEmbeddedHlsManifest(device.platform)) {
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, buildEmbeddedHlsLink(env.PLAYBACK_BASE_URL || "", token));
    }

    const source = await resolveLivePlaybackCandidates(upstream, payload, format);
    const url = source.urls[0];
    if (!url) {
      return res.status(502).json({ error: "playback source unavailable" });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url);
  } catch (err) {
    if (err?.message === "missing upstream base URL") {
      return res.status(500).json({ error: "missing upstream base URL" });
    }
    if (err?.message === "invalid stream type") {
      return res.status(400).json({ error: "invalid stream type" });
    }
    if (err?.status) {
      return res.status(err.status).json({ error: err.message || "playback failed" });
    }
    console.error("[playback/stream] error:", err);
    return res.status(401).json({ error: "invalid token" });
  }
});

router.get("/playback/embedded-hls", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ error: "token required" });

    const { payload, device, upstream } = await resolvePlaybackContext(token);
    if (payload.type !== "live") {
      return res.status(400).json({ error: "embedded hls is only supported for live playback" });
    }
    if (!needsEmbeddedHlsManifest(device.platform)) {
      return res.status(404).json({ error: "embedded hls not enabled for this platform" });
    }

    const format = "hls";
    const source = await resolveLivePlaybackCandidates(upstream, payload, format);
    const manifest = await resolveEmbeddedSamsungManifest(source.urls);

    const manifestText = String(manifest.text || "");
    if (!manifestText.trim()) {
      return res.status(502).json({ error: "upstream returned empty manifest" });
    }

    const rewritten = rewriteM3uManifest(manifestText, manifest.url);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(rewritten);
  } catch (err) {
    if (err?.message === "missing upstream base URL") {
      return res.status(500).json({ error: "missing upstream base URL" });
    }
    if (err?.message === "invalid stream type") {
      return res.status(400).json({ error: "invalid stream type" });
    }
    if (err?.status) {
      return res.status(err.status).json({ error: err.message || "playback failed" });
    }
    return sendInternalError(req, res, "playback/embedded-hls", err);
  }
});

router.get("/playback/embedded-hls-asset", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    const targetUrl = String(req.query.url || "").trim();
    if (!token) return res.status(400).json({ error: "token required" });
    if (!targetUrl) return res.status(400).json({ error: "url required" });
    if (!isHttpUrl(targetUrl)) {
      return res.status(400).json({ error: "invalid asset url" });
    }

    const { payload, device } = await resolvePlaybackContext(token);
    if (payload.type !== "live") {
      return res.status(400).json({ error: "embedded hls asset is only supported for live playback" });
    }
    if (!needsEmbeddedHlsManifest(device.platform)) {
      return res.status(404).json({ error: "embedded hls not enabled for this platform" });
    }

    const asset = await fetchBinaryWithResolvedUrl(targetUrl, {
      method: "GET",
      headers: { "User-Agent": "streamin-api/1.0" },
    }, {
      timeoutMs: env.XUI_REQUEST_TIMEOUT_MS,
    });

    res.setHeader("Cache-Control", "no-store");

    if (isM3uManifest(asset.url, asset.contentType)) {
      const manifestText = asset.buffer.toString("utf8");
      const rewritten = rewriteM3uManifest(manifestText, asset.url);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      return res.send(rewritten);
    }

    res.setHeader("Content-Type", asset.contentType || inferContentType(asset.url));
    return res.send(asset.buffer);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: err.message || "playback failed" });
    }
    return sendInternalError(req, res, "playback/embedded-hls-asset", err);
  }
});

module.exports = router;
