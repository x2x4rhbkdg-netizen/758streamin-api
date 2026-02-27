/** =========================================
 *  ROUTES: Live EPG (JWT required) (CommonJS)
 *  ========================================= */
const { Router } = require("express");
const { authJwt } = require("../middleware/authJwt.cjs");
const { env } = require("../config/env.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const { buildXuiPlayerApiUrls, fetchJsonWithFallback } = require("../utils/xui.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

function parseLimit(v, fallback = 4, max = 120) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, n));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function decodeMaybeBase64(value) {
  const input = String(value || "").trim();
  if (!input) return "";

  // Xtream often returns program title/description in plain text.
  if (!/^[A-Za-z0-9+/=]+$/.test(input) || input.length % 4 !== 0) {
    return input;
  }

  try {
    const decoded = Buffer.from(input, "base64").toString("utf8").trim();
    if (!decoded) return input;
    // Keep decoded only when it looks like readable text.
    if (/^[\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u1E00-\u1EFF]+$/u.test(decoded)) {
      return decoded;
    }
    return input;
  } catch {
    return input;
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unwrapBracketLabel(value) {
  const text = normalizeText(value);
  const m = text.match(/^\[([^\]]+)\]$/);
  return m ? normalizeText(m[1]) : text;
}

function isWeakTitle(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return true;
  if (["unknown", "n/a", "na", "none", "null", "undefined", "-"] .includes(text)) return true;
  if (/^\d{1,2}:\d{2}(\s*-\s*\d{1,2}:\d{2})?$/.test(text)) return true;
  if (/^\d{1,2}:\d{2}\s*(am|pm)?\s*-\s*\d{1,2}:\d{2}\s*(am|pm)?$/.test(text)) return true;
  return false;
}

function pickProgramTitle(item) {
  const candidates = [
    item?.program_title,
    item?.name,
    item?.epg_title,
    item?.title,
    item?.title_en,
    item?.title_local,
  ];

  let fallback = "";
  for (const candidate of candidates) {
    const decoded = unwrapBracketLabel(decodeMaybeBase64(candidate));
    if (!decoded) continue;
    if (!fallback) fallback = decoded;
    if (!isWeakTitle(decoded)) return decoded;
  }

  return fallback || "Unknown";
}

function pickProgramDescription(item) {
  const candidates = [item?.description, item?.desc, item?.plot];
  for (const candidate of candidates) {
    const decoded = normalizeText(decodeMaybeBase64(candidate));
    if (decoded) return decoded;
  }
  return "";
}

function toMs(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 1e12 ? value : value * 1000;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? n : n * 1000;
  }

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeProgram(item) {
  if (!item || typeof item !== "object") return null;

  const title = pickProgramTitle(item);
  const description = pickProgramDescription(item);

  const startMs = toMs(
    item.start_timestamp ||
      item.start ||
      item.start_time ||
      item.start_datetime ||
      item.start_date
  );
  const endMs = toMs(
    item.stop_timestamp ||
      item.end_timestamp ||
      item.end ||
      item.stop ||
      item.end_time ||
      item.stop_time ||
      item.stop_datetime ||
      item.end_datetime
  );

  return {
    title,
    description,
    start: startMs ? new Date(startMs).toISOString() : null,
    end: endMs ? new Date(endMs).toISOString() : null,
    start_ms: startMs,
    end_ms: endMs,
  };
}

async function fetchXuiJson(upstream, action, params = {}) {
  const urls = buildXuiPlayerApiUrls({
    upstream_base_url: upstream.upstream_base_url,
    username: upstream.username,
    password: upstream.password,
  }, { allowHttpFallback: env.XUI_HTTP_FALLBACK });

  const actionParams = { action };
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

function extractListings(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.epg_listings)) return payload.epg_listings;
  if (Array.isArray(payload.listings)) return payload.listings;
  if (Array.isArray(payload.programs)) return payload.programs;
  return [];
}

/** =========================================
 *  GET /v1/live/epg?stream_id=123&limit=96
 *  - Returns normalized Now/Next from upstream short EPG.
 *  ========================================= */
router.get("/live/epg", authJwt, async (req, res) => {
  try {
    const streamId = String(req.query.stream_id || "").trim();
    if (!streamId) return res.status(400).json({ error: "stream_id required" });

    const limit = parseLimit(req.query.limit, 4, 120);

    const upstream = await getDeviceUpstream(req.device.device_id);
    if (!upstream) {
      return res.status(404).json({ error: "no upstream configured for device" });
    }

    let listings = [];

    // Preferred: short EPG (returns compact current/next windows on most Xtream servers).
    try {
      const shortPayload = await fetchXuiJson(upstream, "get_short_epg", {
        stream_id: streamId,
        limit,
      });
      listings = extractListings(shortPayload);
    } catch {
      listings = [];
    }

    // Fallback: simple data table.
    if (!listings.length) {
      try {
        const fallbackPayload = await fetchXuiJson(upstream, "get_simple_data_table", {
          stream_id: streamId,
          limit,
        });
        listings = extractListings(fallbackPayload);
      } catch {
        listings = [];
      }
    }

    const rawWithMs = asArray(listings)
      .map(normalizeProgram)
      .filter(Boolean)
      .sort((a, b) => {
        const aStart = Number(a.start_ms || 0);
        const bStart = Number(b.start_ms || 0);
        return aStart - bStart;
      });

    const items = rawWithMs
      .slice(0, limit)
      .map((item) => ({
        title: item.title,
        description: item.description,
        start: item.start,
        end: item.end,
      }));

    const nowMs = Date.now();
    let nowItem = null;
    let nextItem = null;

    for (const item of rawWithMs) {
      if (item.start_ms && item.end_ms && item.start_ms <= nowMs && nowMs < item.end_ms) {
        nowItem = item;
        continue;
      }
      if (item.start_ms && item.start_ms > nowMs && !nextItem) {
        nextItem = item;
      }
    }

    if (!nowItem && rawWithMs.length) nowItem = rawWithMs[0];
    if (!nextItem && rawWithMs.length > 1) {
      const nowIndex = rawWithMs.indexOf(nowItem);
      if (nowIndex >= 0 && nowIndex + 1 < rawWithMs.length) {
        nextItem = rawWithMs[nowIndex + 1];
      } else {
        nextItem = rawWithMs[1];
      }
    }

    return res.json({
      stream_id: streamId,
      now: nowItem
        ? {
            title: nowItem.title,
            description: nowItem.description,
            start: nowItem.start,
            end: nowItem.end,
          }
        : null,
      next: nextItem
        ? {
            title: nextItem.title,
            description: nextItem.description,
            start: nextItem.start,
            end: nextItem.end,
          }
        : null,
      items,
    });
  } catch (err) {
    const status = err?.status || 500;
    if (status !== 500) {
      return res.status(status).json({
        error: err?.message || "upstream failed",
        status,
        body: err?.body,
      });
    }
    return sendInternalError(req, res, "live/epg", err);
  }
});

module.exports = router;
