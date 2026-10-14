const { pool } = require('../db/pool.cjs');
const { encryptString, decryptString } = require('./cryptoVault.cjs');
const { normalizeAddons, publicAddons } = require('./stremioAddons.cjs');

const PROVIDERS = ['none', 'Real-Debrid', 'Premiumize', 'EasyDebrid', 'OffCloud', 'Torbox'];
const SECRETS = ['tmdb_read_access_token', 'debrid_token', 'trakt_access_token'];
const ACCESS_KEYS = ['enabled', 'anime_enabled', 'live_tv_enabled', 'radio_enabled'];
const DEFAULTS = Object.freeze({ enabled: false, anime_enabled: false, live_tv_enabled: true, radio_enabled: true, scraper_url: '', provider: 'none', default_provider: 'none',
  min_bitrate_mbps: 0, max_bitrate_mbps: 20, hide_phrases: '', auto_select: false, max_links: 10,
  primary_sort: 'quality', primary_sort_direction: 'desc', secondary_sort: 'bitrate', secondary_sort_direction: 'desc',
  auto_select_min_links: 10, auto_select_delay: false, auto_select_delay_seconds: 15,
  enable_software_codecs: false, prefer_software_codecs: false });

function providerAccounts(settings) {
  const accounts = {};
  for (const provider of PROVIDERS.filter((name) => name !== 'none')) {
    const stored = settings.provider_accounts?.[provider];
    accounts[provider] = { enabled: stored?.enabled === true, token: stored?.token || '' };
  }
  // Preserve the existing single-provider configuration on first read.
  if (!settings.provider_accounts && accounts[settings.provider]) {
    accounts[settings.provider] = { enabled: true, token: settings.debrid_token || '' };
  }
  return accounts;
}

function normalizeProviderAccounts(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Provider accounts must be an object');
  const accounts = providerAccounts(previous);
  for (const [provider, value] of Object.entries(input)) {
    if (!Object.hasOwn(accounts, provider)) invalid('Unsupported movie provider');
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some((key) => !['enabled', 'token'].includes(key))) invalid('Invalid provider account');
    if (Object.hasOwn(value, 'enabled')) {
      if (typeof value.enabled !== 'boolean') invalid('Provider enabled must be a boolean');
      accounts[provider].enabled = value.enabled;
    }
    if (Object.hasOwn(value, 'token')) {
      if (typeof value.token !== 'string' || value.token.length > 8192) invalid('Invalid provider token');
      accounts[provider].token = value.token.trim();
    }
  }
  return accounts;
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function normalizeSettings(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Movie settings must be an object');
  const next = { ...DEFAULTS, ...previous };
  if (Object.hasOwn(input, 'stremio_addons')) next.stremio_addons = normalizeAddons(input.stremio_addons, previous.stremio_addons);
  if (Object.hasOwn(input, 'default_provider')) {
    if (input.default_provider !== 'auto' && !PROVIDERS.includes(input.default_provider)) invalid('Unsupported default movie provider');
    next.default_provider = input.default_provider;
  }
  for (const key of [...ACCESS_KEYS, 'auto_select', 'auto_select_delay', 'enable_software_codecs', 'prefer_software_codecs']) {
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
  for (const [key, min, max] of [['max_bitrate_mbps', 1, 100], ['min_bitrate_mbps', 0, 100], ['max_links', 1, 50],
    ['auto_select_min_links', 1, 50], ['auto_select_delay_seconds', 0, 60]]) {
    if (Object.hasOwn(input, key)) {
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < min || value > max) invalid(`${key} must be between ${min} and ${max}`);
      next[key] = value;
    }
  }
  if (next.min_bitrate_mbps > next.max_bitrate_mbps) invalid('Minimum bitrate must not exceed maximum bitrate');
  for (const key of ['primary_sort', 'secondary_sort']) {
    if (Object.hasOwn(input, key)) {
      if (!['quality', 'bitrate', 'size', 'seeders'].includes(input[key])) invalid(`Invalid ${key}`);
      next[key] = input[key];
    }
  }
  for (const key of ['primary_sort_direction', 'secondary_sort_direction']) {
    if (Object.hasOwn(input, key)) {
      if (!['asc', 'desc'].includes(input[key])) invalid(`Invalid ${key}`);
      next[key] = input[key];
    }
  }
  if (!next.enable_software_codecs) next.prefer_software_codecs = false;
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
  result.provider_accounts = Object.fromEntries(Object.entries(providerAccounts(settings)).map(([provider, account]) =>
    [provider, { enabled: account.enabled, token_configured: Boolean(account.token) }]));
  return result;
}

async function readStoredDeviceSettings(deviceId) {
  try {
    const [rows] = await pool.execute('SELECT settings_enc FROM device_movie_settings WHERE device_id=? LIMIT 1', [deviceId]);
    return rows[0] ? { ...DEFAULTS, ...JSON.parse(decryptString(rows[0].settings_enc)) } : { ...DEFAULTS };
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULTS };
    throw error;
  }
}

async function saveMovieSettings(deviceId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.keys(input).length || Object.keys(input).some((key) => !ACCESS_KEYS.includes(key) || typeof input[key] !== 'boolean')) {
    invalid('Device access accepts only enabled, anime_enabled, live_tv_enabled and radio_enabled booleans');
  }
  const settings = normalizeSettings(input, await readStoredDeviceSettings(deviceId));
  await pool.execute(`INSERT INTO device_movie_settings (device_id, settings_enc) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE settings_enc=VALUES(settings_enc), updated_at=NOW()`,
  [deviceId, encryptString(JSON.stringify(settings))]);
  return deviceAccess(settings);
}

function deviceAccess(settings) {
  return { enabled: settings.enabled === true, anime_enabled: settings.anime_enabled === true, live_tv_enabled: settings.live_tv_enabled !== false,
    radio_enabled: settings.radio_enabled !== false };
}

async function readDeviceMovieAccess(deviceId) {
  const settings = await readStoredDeviceSettings(deviceId);
  return deviceAccess(settings);
}

async function readGlobalMovieSettings() {
  let settings = { ...DEFAULTS };
  try {
    const [rows] = await pool.execute('SELECT settings_enc FROM global_movie_settings WHERE id=1 LIMIT 1');
    if (rows[0]) settings = { ...settings, ...JSON.parse(decryptString(rows[0].settings_enc)) };
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  for (const key of ACCESS_KEYS) delete settings[key];
  settings.provider_accounts = providerAccounts(settings);
  return settings;
}

async function saveGlobalMovieSettings(input) {
  if (input && ACCESS_KEYS.some((key) => Object.hasOwn(input, key))) invalid('Service access is controlled per device');
  const previous = await readGlobalMovieSettings();
  const settings = normalizeSettings(input, previous);
  if (Object.hasOwn(input, 'provider_accounts')) {
    settings.provider_accounts = normalizeProviderAccounts(input.provider_accounts, settings);
  } else if (Object.hasOwn(input, 'provider') || Object.hasOwn(input, 'debrid_token')) {
    // Compatibility for the previously deployed single-provider form.
    settings.provider_accounts = providerAccounts(settings);
    if (previous.provider !== settings.provider && settings.provider_accounts[previous.provider]) {
      settings.provider_accounts[previous.provider].enabled = false;
    }
    if (settings.provider_accounts[settings.provider]) {
      settings.provider_accounts[settings.provider] = { enabled: true, token: settings.debrid_token || '' };
    }
  }
  for (const key of ACCESS_KEYS) delete settings[key];
  if (!['none', 'auto'].includes(settings.default_provider) && !settings.provider_accounts[settings.default_provider]?.enabled) {
    invalid('Enable the default movie provider before saving');
  }
  await pool.execute(`INSERT INTO global_movie_settings (id, settings_enc) VALUES (1, ?)
    ON DUPLICATE KEY UPDATE settings_enc=VALUES(settings_enc), updated_at=NOW()`,
  [encryptString(JSON.stringify(settings))]);
  return settings;
}

function adminGlobalSettings(settings) {
  const result = { ...publicSettings(settings), scraper_url: settings.scraper_url, stremio_addons: publicAddons(settings.stremio_addons) };
  for (const key of ACCESS_KEYS) delete result[key];
  return result;
}

async function readMovieSettings(deviceId) {
  const [globalSettings, access] = await Promise.all([
    readGlobalMovieSettings(), readDeviceMovieAccess(deviceId),
  ]);
  return { ...globalSettings, ...access };
}

module.exports = { DEFAULTS, normalizeSettings, publicSettings, readMovieSettings, saveMovieSettings,
  readDeviceMovieAccess, readGlobalMovieSettings, saveGlobalMovieSettings, adminGlobalSettings };
