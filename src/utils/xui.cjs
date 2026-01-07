/** =========================================
 *  UTILS: XUI (Xtream Codes style) (CommonJS)
 *  ========================================= */

/** =========================================
 *  HELPERS: Normalize Base URL
 *  - trims whitespace
 *  - trims trailing slashes
 *  ========================================= */
function normalizeBaseUrl(v) {
  return String(v || "").trim().replace(/\/+$/, "");
}

/** =========================================
 *  Build M3U URL
 *  - get.php?username=...&password=...&type=m3u_plus&output=m3u8|ts
 *  ========================================= */
function buildXuiM3uUrl({ upstream_base_url, username, password, output = "m3u8" }) {
  const base = normalizeBaseUrl(upstream_base_url);

  const u = new URL(`${base}/get.php`);
  u.searchParams.set("username", username);
  u.searchParams.set("password", password);
  u.searchParams.set("type", "m3u_plus");
  u.searchParams.set("output", output); // "m3u8" or "ts"

  return u.toString();
}

/** =========================================
 *  Build Player API URL (JSON)
 *  - player_api.php?username=...&password=...
 *  ========================================= */
function buildXuiPlayerApiUrl({ upstream_base_url, username, password }) {
  const base = normalizeBaseUrl(upstream_base_url);

  const u = new URL(`${base}/player_api.php`);
  u.searchParams.set("username", username);
  u.searchParams.set("password", password);

  return u.toString();
}

/** =========================================
 *  Build XMLTV EPG URL
 *  - xmltv.php?username=...&password=...
 *  ========================================= */
function buildXuiEpgUrl({ upstream_base_url, username, password }) {
  const base = normalizeBaseUrl(upstream_base_url);

  const u = new URL(`${base}/xmltv.php`);
  u.searchParams.set("username", username);
  u.searchParams.set("password", password);

  return u.toString();
}

module.exports = {
  normalizeBaseUrl,
  buildXuiM3uUrl,
  buildXuiPlayerApiUrl,
  buildXuiEpgUrl,
};