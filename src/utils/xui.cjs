/** =========================================
 *  UTILS: XUI (Xtream Codes style) (CommonJS)
 *  - Builds standard Xtream endpoints (get.php, player_api.php, xmltv.php)
 *  - Defensive URL handling + optional HTTPS -> HTTP fallback
 *  ========================================= */

const TRANSPORT_MEMORY_TTL_MS = 10 * 60 * 1000;
const transportMemory = new Map();

function dedupe(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function toHostKey(base) {
  try {
    const u = new URL(base);
    return String(u.host || "").toLowerCase();
  } catch {
    return "";
  }
}

function rememberTransport(urlValue) {
  try {
    const u = new URL(String(urlValue || ""));
    const hostKey = String(u.host || "").toLowerCase();
    if (!hostKey) return;
    transportMemory.set(hostKey, {
      protocol: u.protocol,
      expiresAt: Date.now() + TRANSPORT_MEMORY_TTL_MS,
    });
  } catch {
    // ignore
  }
}

function getRememberedTransport(base) {
  const hostKey = toHostKey(base);
  if (!hostKey) return "";
  const entry = transportMemory.get(hostKey);
  if (!entry) return "";
  if (Number(entry.expiresAt || 0) <= Date.now()) {
    transportMemory.delete(hostKey);
    return "";
  }
  return String(entry.protocol || "");
}

/** =========================================
 *  HELPERS: Coerce a safe base URL
 *  - trims whitespace
 *  - fixes missing scheme (infers from port where possible)
 *  - trims trailing slashes
 *  - rejects obviously bad values
 *  ========================================= */
function normalizeBaseUrl(v) {
  let s = String(v || "").trim();

  s = s.replace(/[\u2018\u2019\u201C\u201D]/g, '"');
  s = s.replace(/,+$/g, "");
  s = s.replace(/:(["'])(\d+)\1/g, ":$2");

  if (!s) return "";

  if (!/^https?:\/\//i.test(s)) {
    let inferred = "https";
    try {
      const probe = new URL(`http://${s}`);
      const port = String(probe.port || "");
      if (port && port !== "443" && port !== "8443") {
        inferred = "http";
      }
    } catch {
      // keep default inferred scheme
    }
    s = `${inferred}://${s}`;
  }

  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function buildBaseCandidates(base, options = {}) {
  const allowHttpFallback = options.allowHttpFallback !== false;
  const primary = normalizeBaseUrl(base);
  if (!primary) return [];

  let parsed;
  try {
    parsed = new URL(primary);
  } catch {
    return [primary];
  }

  const list = [primary];
  if (allowHttpFallback && parsed.protocol === "https:") {
    const host = parsed.hostname;
    const port = String(parsed.port || "");

    if (!port) {
      list.push(`http://${host}`);
    } else if (port === "443") {
      list.push(`http://${host}`);
      list.push(`http://${host}:443`);
    } else if (port === "8443") {
      list.push(`http://${host}:8080`);
      list.push(`http://${host}`);
      list.push(`http://${host}:8443`);
    } else {
      list.push(`http://${host}:${port}`);
      list.push(`http://${host}`);
    }
  }

  const remembered = getRememberedTransport(primary);
  if (remembered === "http:" || remembered === "https:") {
    list.sort((a, b) => {
      const ap = (() => {
        try {
          return new URL(a).protocol;
        } catch {
          return "";
        }
      })();
      const bp = (() => {
        try {
          return new URL(b).protocol;
        } catch {
          return "";
        }
      })();
      if (ap === remembered && bp !== remembered) return -1;
      if (bp === remembered && ap !== remembered) return 1;
      return 0;
    });
  }

  return dedupe(list);
}

function applyParams(urlString, params = {}) {
  const u = new URL(urlString);
  Object.entries(params).forEach(([k, val]) => {
    if (val === undefined || val === null) return;
    u.searchParams.set(k, String(val));
  });
  return u.toString();
}

/** =========================================
 *  HELPERS: Build URL with path + query
 *  ========================================= */
function buildUrl(base, pathname, params = {}, options = {}) {
  const candidates = buildBaseCandidates(base, options);
  const b = candidates[0];
  if (!b) throw new Error("Invalid upstream_base_url");

  const joined = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, `${b}/`).toString();
  return applyParams(joined, params);
}

function buildUrlCandidates(base, pathname, params = {}, options = {}) {
  const bases = buildBaseCandidates(base, options);
  return bases.map((b) => {
    const joined = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, `${b}/`).toString();
    return applyParams(joined, params);
  });
}

function withTimeout(ms) {
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: undefined, cancel: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function fetchTextWithFallback(urls, init = {}, options = {}) {
  const list = dedupe(Array.isArray(urls) ? urls : [urls]);
  if (!list.length) throw new Error("No upstream URL candidates");

  const timeoutMs = Number(options.timeoutMs || 0);
  let lastErr = null;

  for (let i = 0; i < list.length; i += 1) {
    const url = list[i];
    const hasNext = i < list.length - 1;
    const { signal, cancel } = withTimeout(timeoutMs);

    try {
      const resp = await fetch(url, {
        ...init,
        signal: signal || init.signal,
      });
      const txt = await resp.text().catch(() => "");

      if (!resp.ok) {
        const err = new Error("upstream failed");
        err.status = resp.status;
        err.body = txt.slice(0, 200);
        err.url = url;
        lastErr = err;

        if (hasNext && resp.status >= 500) {
          continue;
        }
        throw err;
      }

      rememberTransport(url);
      return txt;
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      const retryableNetwork = !status;
      const retryableStatus = status >= 500;

      if (hasNext && (retryableNetwork || retryableStatus)) {
        continue;
      }

      throw err;
    } finally {
      cancel();
    }
  }

  throw lastErr || new Error("upstream failed");
}

async function fetchJsonWithFallback(urls, init = {}, options = {}) {
  const txt = await fetchTextWithFallback(urls, init, options);
  try {
    return JSON.parse(txt);
  } catch {
    const err = new Error("upstream returned invalid JSON");
    err.status = 502;
    err.body = String(txt || "").slice(0, 200);
    throw err;
  }
}

/** =========================================
 *  Build M3U URL
 *  ========================================= */
function buildXuiM3uUrl({ upstream_base_url, username, password, output = "m3u8" }) {
  return buildUrl(upstream_base_url, "/get.php", {
    username,
    password,
    type: "m3u_plus",
    output,
  });
}

function buildXuiM3uUrls({ upstream_base_url, username, password, output = "m3u8" }, options = {}) {
  return buildUrlCandidates(
    upstream_base_url,
    "/get.php",
    {
      username,
      password,
      type: "m3u_plus",
      output,
    },
    options
  );
}

/** =========================================
 *  Build Player API URL (JSON)
 *  ========================================= */
function buildXuiPlayerApiUrl({ upstream_base_url, username, password }) {
  return buildUrl(upstream_base_url, "/player_api.php", { username, password });
}

function buildXuiPlayerApiUrls({ upstream_base_url, username, password }, options = {}) {
  return buildUrlCandidates(
    upstream_base_url,
    "/player_api.php",
    { username, password },
    options
  );
}

/** =========================================
 *  Build XMLTV EPG URL
 *  ========================================= */
function buildXuiEpgUrl({ upstream_base_url, username, password }) {
  return buildUrl(upstream_base_url, "/xmltv.php", { username, password });
}

module.exports = {
  normalizeBaseUrl,
  buildBaseCandidates,
  buildUrl,
  buildUrlCandidates,
  buildXuiM3uUrl,
  buildXuiM3uUrls,
  buildXuiPlayerApiUrl,
  buildXuiPlayerApiUrls,
  buildXuiEpgUrl,
  fetchTextWithFallback,
  fetchJsonWithFallback,
  rememberTransport,
};
