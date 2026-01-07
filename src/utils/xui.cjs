/** =========================================
 *  UTILS: XUI (Xtream Codes style) (CommonJS)
 *  - Builds standard Xtream endpoints (get.php, player_api.php, xmltv.php)
 *  - More defensive URL handling (scheme/ports/trailing slashes)
 *  ========================================= */

/** =========================================
 *  HELPERS: Coerce a safe base URL
 *  - trims whitespace
 *  - fixes missing scheme (defaults to https://)
 *  - trims trailing slashes
 *  - rejects obviously bad values
 *  ========================================= */
function normalizeBaseUrl(v) {
  let s = String(v || "").trim();

  // Guard against smart quotes copied from dashboards
  s = s.replace(/[\u2018\u2019\u201C\u201D]/g, '"');

  // Common copy/paste mistakes
  s = s.replace(/,+$/g, ""); // trailing commas
  s = s.replace(/:(['\"])(\d+)\1/g, ":$2"); // :"443" or :'443' -> :443

  if (!s) return "";

  // If user passes host:port without scheme, default to https
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }

  // Validate + coerce to origin only (base host + port, no path)
  try {
    const u = new URL(s);
    // Enforce user's contract: base is host + optional port only
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** =========================================
 *  HELPERS: Build URL with path + query
 *  ========================================= */
function buildUrl(base, pathname, params = {}) {
  const b = normalizeBaseUrl(base);
  if (!b) throw new Error("Invalid upstream_base_url");

  // Use URL constructor so path joining is always correct
  const u = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, `${b}/`);

  Object.entries(params).forEach(([k, val]) => {
    if (val === undefined || val === null) return;
    u.searchParams.set(k, String(val));
  });

  return u.toString();
}

/** =========================================
 *  Build M3U URL
 *  - get.php?username=...&password=...&type=m3u_plus&output=m3u8|ts
 *  ========================================= */
function buildXuiM3uUrl({ upstream_base_url, username, password, output = "m3u8" }) {
  return buildUrl(upstream_base_url, "/get.php", {
    username,
    password,
    type: "m3u_plus",
    output, // "m3u8" or "ts"
  });
}

/** =========================================
 *  Build Player API URL (JSON)
 *  - player_api.php?username=...&password=...
 *  ========================================= */
function buildXuiPlayerApiUrl({ upstream_base_url, username, password }) {
  return buildUrl(upstream_base_url, "/player_api.php", { username, password });
}

/** =========================================
 *  Build XMLTV EPG URL
 *  - xmltv.php?username=...&password=...
 *  ========================================= */
function buildXuiEpgUrl({ upstream_base_url, username, password }) {
  return buildUrl(upstream_base_url, "/xmltv.php", { username, password });
}

module.exports = {
  normalizeBaseUrl,
  buildUrl,
  buildXuiM3uUrl,
  buildXuiPlayerApiUrl,
  buildXuiEpgUrl,
};