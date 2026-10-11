const { pool } = require('../db/pool.cjs');
const { encryptString, decryptString } = require('./cryptoVault.cjs');

const PROVIDERS = ['none', 'Real-Debrid', 'Premiumize', 'EasyDebrid', 'OffCloud', 'Torbox'];
const SECRETS = ['tmdb_read_access_token', 'debrid_token', 'trakt_access_token'];
const DEFAULTS = Object.freeze({ enabled: false, scraper_url: '', provider: 'none',
  max_bitrate_mbps: 20, hide_phrases: '', auto_select: false, max_links: 10 });

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function normalizeSettings(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Movie settings must be an object');
  const next = { ...DEFAULTS, ...previous };
  for (const key of ['enabled', 'auto_select']) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== 'boolean') invalid(`${key} must be a boolean`);
      next[key] = input[key];
    }
  }
  if (Object.hasOwn(input, 'provider')) {
    if (!PROVIDERS.includes(input.provider)) invalid('Unsupported movie provider');
    if (next.provider !== input.provider) next.debrid_token = '';
    next.provider = input.provider;
  }
  if (Object.hasOwn(input, 'scraper_url')) {
    next.scraper_url = String(input.scraper_url || '').trim();
    if (next.scraper_url) {
      let url;
      try { url = new URL(next.scraper_url); } catch { invalid('Invalid scraper URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('Scraper URL must use HTTP or HTTPS without embedded credentials');
      if (next.scraper_url.length > 2048) invalid('Scraper URL is too long');
    }
  }
  for (const [key, min, max] of [['max_bitrate_mbps', 1, 100], ['max_links', 1, 50]]) {
    if (Object.hasOwn(input, key)) {
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < min || value > max) invalid(`${key} must be between ${min} and ${max}`);
      next[key] = value;
    }
  }
  if (Object.hasOwn(input, 'hide_phrases')) {
    next.hide_phrases = String(input.hide_phrases || '').trim();
    if (next.hide_phrases.length > 500) invalid('Filter phrases are too long');
  }
  for (const key of SECRETS) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== 'string' || input[key].length > 8192) invalid(`Invalid ${key}`);
      next[key] = input[key].trim();
    }
  }
  return next;
}

function publicSettings(settings) {
  const result = {};
  for (const key of Object.keys(DEFAULTS)) result[key] = settings[key] ?? DEFAULTS[key];
  // Configured scraper URLs may contain provider keys in their path or query.
  delete result.scraper_url;
  result.scraper_configured = Boolean(settings.scraper_url);
  for (const key of SECRETS) result[`${key}_configured`] = Boolean(settings[key]);
  return result;
}

async function readMovieSettings(deviceId) {
  try {
    const [rows] = await pool.execute('SELECT settings_enc FROM device_movie_settings WHERE device_id=? LIMIT 1', [deviceId]);
    return rows[0] ? { ...DEFAULTS, ...JSON.parse(decryptString(rows[0].settings_enc)) } : { ...DEFAULTS };
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULTS };
    throw error;
  }
}

async function saveMovieSettings(deviceId, input) {
  const settings = normalizeSettings(input, await readMovieSettings(deviceId));
  await pool.execute(`INSERT INTO device_movie_settings (device_id, settings_enc) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE settings_enc=VALUES(settings_enc), updated_at=NOW()`,
  [deviceId, encryptString(JSON.stringify(settings))]);
  return settings;
}

module.exports = { DEFAULTS, normalizeSettings, publicSettings, readMovieSettings, saveMovieSettings };
