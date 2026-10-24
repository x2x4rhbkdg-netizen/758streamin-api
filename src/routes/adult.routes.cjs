const { Router } = require('express');
const crypto = require('node:crypto');
const { authJwt } = require('../middleware/authJwt.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { createAdultTokens, readAdultPin } = require('../utils/adultAccess.cjs');
const { addonVersion } = require('../utils/adultAddons.cjs');
const { createAdultCatalogClient, adultCatalogProviders, validateAdultSelection } = require('../utils/adultCatalogClient.cjs');
const { lookupProviders, resolveMovieSource } = require('../utils/movieResolver.cjs');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { createMediaHistoryStore, normalizeProgress, hash } = require('../utils/mediaHistory.cjs');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function createAdultRouter({ auth = authJwt, readSettings = readMovieSettings, readPin = readAdultPin,
  client = createAdultCatalogClient(), lookup = lookupProviders, resolve = resolveMovieSource,
  tokens = () => createAdultTokens(process.env.JWT_SECRET), tickets = () => createPlaybackTickets(process.env.JWT_SECRET),
  history = createMediaHistoryStore(), now = Date.now } = {}) {
  const router = Router();
  const attempts = new Map(), requests = new Map(), active = new Set();
  function rate(map, device, max, window) {
    const time = now();
    for (const [key, value] of map) if (value.expires <= time) map.delete(key);
    const record = map.get(device) || { count: 0, expires: time + window };
    if (record.count >= max || !map.has(device) && map.size >= 10000) throw fail('Too many requests. Try again shortly.', 429);
    record.count++; map.set(device, record);
  }
  function capability(req, purpose, token) {
    const value = tokens().read(token, purpose, req.device.device_id);
    if (value.fingerprint !== req.adultPin.fingerprint || value.age_confirmed !== true) throw fail('Confirm you are 18 or older and unlock Adult Content again', 403);
    return value;
  }
  function issue(req, purpose, data, ttl) {
    return tokens().issue(purpose, req.device.device_id, { ...data, fingerprint: req.adultPin.fingerprint, age_confirmed: true }, ttl);
  }
  const historyKey = item => hash(`${item.addon_id}:${item.type}:${item.id}:${item.season ?? ''}:${item.episode ?? ''}`);
  const historyItem = item => ({ addon_id: item.addon_id, addon_version: item.addon_version, id: item.id,
    type: item.type, title: item.title, poster: item.poster, season: item.season, episode: item.episode,
    ...(item.addon_id === '__tpdb' ? { tpdb_kind: item.tpdb_kind, tpdb_id: item.tpdb_id, year: item.year } : {}) });
  async function historyItems(req) {
    const owner = await history.owner(req.device.device_id);
    const records = await history.list(owner, ['adult']);
    return records.filter(record => record.position >= 10 && record.position < record.duration - 30 &&
      adultCatalogProviders(req.adultSettings).some(addon => addon.id === record.item?.addon_id && addonVersion(addon) === record.item.addon_version))
      .map(record => ({ ...record.item, resume_position: record.position }));
  }
  function protectedUrl(req, url) {
    const base = new URL(process.env.MOVIE_PLAYBACK_BASE_URL || 'https://api.758streamin.com');
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid playback base URL');
    const ticket = tickets().issue(url, req.device.device_id, 'adult', req.adultPin.fingerprint);
    return new URL(`/v1/movies/stream/${ticket}`, base).href;
  }
  function route(path, run, unlock = true) {
    router.post(`/adult/${path}`, auth, async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      const device = String(req.device.device_id);
      let reserved = false;
      try {
        req.adultSettings = await readSettings(device);
        if (req.adultSettings.adult_enabled !== true) throw fail('Adult Content is disabled for this device', 403);
        if (active.has(device) || active.size >= 8) throw fail('Adult requests are busy. Try again shortly.', 429);
        active.add(device); reserved = true;
        rate(requests, device, 60, 60000);
        if (path === 'unlock') rate(attempts, device, 5, 5 * 60000);
        req.adultPin = await readPin(device);
        if (!req.adultPin) throw fail('Set a parental PIN before opening Adult Content', 409);
        if (unlock) capability(req, 'unlock', req.body?.unlock_token);
        return res.json(await run(req));
      } catch (error) {
        return res.status(error.status || 502).json({ error: error.status ? error.message : 'Adult service temporarily unavailable' });
      } finally { if (reserved) active.delete(device); }
    });
  }
  route('unlock', async (req) => {
    if (req.body?.age_confirmed !== true) throw fail('Confirm you are 18 or older before opening Adult Content', 403);
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    const stored = String(req.adultPin.pin);
    if (!/^\d{4}$/.test(pin) || Buffer.byteLength(stored) !== 4 ||
      !crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(stored))) throw fail('Invalid parental PIN', 403);
    return { unlock_token: issue(req, 'unlock', {}) };
  }, false);
  route('catalogs', async (req) => {
    const result = await client.catalogs(req.adultSettings);
    return { ...result, catalogs: [{ addon_id: '__history', id: '__history', type: 'history', name: 'Continue Watching', addon_name: 'Account history' }, ...(result.catalogs || [])] };
  });
  route('catalog', async (req) => {
    const result = req.body?.addon_id === '__history' && req.body?.catalog_id === '__history'
      ? { items: await historyItems(req), has_more: false } : await client.catalog(req.adultSettings, req.body || {});
    return { ...result, items: result.items.map((item) => ({ title: item.title, type: item.type,
      item_token: issue(req, 'item', item), ...(Number.isFinite(item.resume_position) ? { resume_position: item.resume_position } : {}),
      ...(item.poster ? { poster_url: protectedUrl(req, item.poster) } : {}) })) };
  });
  route('details', async (req) => {
    const item = capability(req, 'item', req.body?.item_token);
    const result = await client.details(req.adultSettings, item);
    return { title: result.title, overview: result.overview, type: result.type,
      videos: result.videos.map((video) => ({ title: video.title, item_token: issue(req, 'item', video) })) };
  });
  route('sources', async (req) => {
    const item = capability(req, 'item', req.body?.item_token);
    const sources = await client.sources(req.adultSettings, item);
    const available = sources.some((source) => source.hash) ? await lookup(req.adultSettings, sources.filter((source) => source.hash)) : { available: {} };
    return { sources: sources.map((source) => ({ title: source.title, direct: !!source.url,
      ...(source.quality ? { quality: String(source.quality).slice(0, 40) } : {}),
      ...(source.scraper ? { scraper: String(source.scraper).slice(0, 100) } : {}),
      ...(Number.isFinite(source.size_bytes) && source.size_bytes > 0 ? { size_bytes: source.size_bytes } : {}),
      ...(Number.isFinite(source.bitrate_mbps) && source.bitrate_mbps > 0 ? { bitrate_mbps: source.bitrate_mbps } : {}),
      providers: source.hash ? available.available?.[source.hash] || [] : [],
      on_demand_providers: source.hash ? available.on_demand?.[source.hash] || [] : [],
      source_token: issue(req, 'source', { item: historyItem(item), source }) })) };
  });
  route('resolve', async (req) => {
    const { item, source } = capability(req, 'source', req.body?.source_token);
    validateAdultSelection(req.adultSettings, item, source);
    let url = source.url, provider = '';
    if (!url) {
      if (item.type === 'series' && (!Number.isInteger(item.season) || !Number.isInteger(item.episode))) throw fail('This add-on did not identify the episode for provider playback', 409);
      // A title-search result must never pick the largest file from an ambiguous multi-video pack.
      const customType = source.source_kind === 'shared_scraper' || !['movie', 'series'].includes(item.type);
      const result = await resolve(req.adultSettings, { section: 'adult', type: item.type === 'series' ? 'series' : 'movie', adult_custom_type: customType,
        hash: source.hash, file_name: source.file_name, season_int: item.season, episode_int: item.episode,
        provider: req.body?.provider || 'auto', allow_uncached_rd: req.body?.allow_uncached_rd === true, allow_uncached_ad: req.body?.allow_uncached_ad === true });
      url = result.protectedPlaybackUrl || result.playbackUrl; provider = result.provider;
    }
    let progress = {};
    if (item.id) {
      try {
        const owner = await history.owner(req.device.device_id);
        const key = historyKey(item);
        const previous = (await history.list(owner, ['adult'])).find(record => record.id === key);
        // Write-only capability for this selected title; it grants no catalog/history reads.
        progress = { history_progress_token: issue(req, 'progress', { owner, key, item }, 6 * 60 * 60 * 1000),
          resume_position: previous?.position >= 10 && previous.position < previous.duration - 30 ? previous.position : 0 };
      } catch { /* Playback remains available before the history migration is deployed. */ }
    }
    return { playbackUrl: protectedUrl(req, url), provider, ...progress };
  });
  route('progress', async (req) => {
    const grant = capability(req, 'progress', req.body?.history_progress_token);
    const owner = await history.owner(req.device.device_id);
    if (grant.owner !== owner) throw fail('History account changed', 409);
    const progress = normalizeProgress(req.body, now());
    await history.put(owner, 'adult', grant.key, { id: grant.key, item: grant.item, ...progress });
    return { ok: true };
  }, false);
  return router;
}
module.exports = createAdultRouter();
module.exports.createAdultRouter = createAdultRouter;
