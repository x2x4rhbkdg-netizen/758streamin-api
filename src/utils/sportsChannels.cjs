const { createHash } = require('node:crypto');
const { getSportsEvents } = require('./sportsEvents.cjs');
const { epgMatchesEvent, fetchSportsEpg } = require('./sportsEpg.cjs');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function channelName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\+/g, ' plus ').replace(/&/g, ' and ')
    .replace(/\b(?:fhd|uhd|hd|sd|4k|8k|1080p|720p|hevc|h264|h265|backup)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/^(?:(?:us|usa|uk|gb|ca|can|au|nz|ie)\s+)+/, '')
    .replace(/([a-z])([0-9])/g, '$1 $2').replace(/([0-9])([a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}
function normalizeSportsAliases(value) {
  if (!Array.isArray(value) || value.length > 200) throw fail('Send up to 200 broadcaster mappings');
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['broadcaster', 'channels'].includes(key)) ||
        typeof row.broadcaster !== 'string' || !row.broadcaster.trim() || row.broadcaster.length > 100 || /[\x00-\x1f]/.test(row.broadcaster) ||
        !Array.isArray(row.channels) || !row.channels.length || row.channels.length > 20 ||
        row.channels.some(name => typeof name !== 'string' || !channelName(name) || name.length > 120 || /[\x00-\x1f]/.test(name))) throw fail('Enter a broadcaster and 1 to 20 channel names per mapping');
    const key = channelName(row.broadcaster);
    if (!key || seen.has(key)) throw fail('Each broadcaster must have one mapping');
    seen.add(key);
    return { broadcaster: row.broadcaster.trim(), channels: [...new Set(row.channels.map(name => name.trim()))] };
  });
}
function eligibleStreams(streams, categories) {
  const allowedCategories = new Set(categories.filter(category => !/radio|adult|xxx|18\+|porn|hentai/i.test(String(category.category_name || category.name || '')))
    .map(category => String(category.category_id ?? category.id ?? '')).filter(Boolean));
  const seen = new Set();
  return streams.filter(stream => {
    const id = String(stream.stream_id || '');
    if (!/^\d+$/.test(id) || !allowedCategories.has(String(stream.category_id || '')) || seen.has(id) ||
        String(stream.is_adult).toLowerCase() === 'true' || Number(stream.is_adult) === 1 ||
        stream.stream_type && stream.stream_type !== 'live' || typeof stream.name !== 'string' || stream.name.length > 300) return false;
    seen.add(id); return true;
  });
}
function matchSportsChannels(broadcasters, streams, categories, aliases = []) {
  const wanted = new Map();
  for (const broadcaster of broadcasters) {
    const key = channelName(broadcaster);
    if (!key) continue;
    wanted.set(key, { broadcaster, kind: 'exact' });
    const mapping = aliases.find(row => channelName(row.broadcaster) === key);
    for (const alias of mapping?.channels || []) if (!wanted.has(channelName(alias))) wanted.set(channelName(alias), { broadcaster, kind: 'alias' });
  }
  return eligibleStreams(streams, categories).flatMap(stream => {
    const id = String(stream.stream_id || ''), categoryId = String(stream.category_id || '');
    const match = wanted.get(channelName(stream.name));
    if (!match) return [];
    // Never expose provider credentials, stream URLs, or arbitrary upstream fields.
    return [{ stream_id: id, category_id: categoryId, name: stream.name, broadcaster: match.broadcaster, match_type: match.kind }];
  }).sort((a, b) => Number(a.match_type === 'alias') - Number(b.match_type === 'alias') || a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 60);
}

async function fetchLiveCatalog(upstream) {
  const { buildXuiPlayerApiUrls, fetchJsonWithFallback } = require('./xui.cjs');
  const { env } = require('../config/env.cjs');
  const urls = buildXuiPlayerApiUrls(upstream, { allowHttpFallback: env.XUI_HTTP_FALLBACK });
  const load = action => fetchJsonWithFallback(urls.map(value => {
    const url = new URL(value); url.searchParams.set('action', action); return url.href;
  }), { method: 'GET', headers: { 'User-Agent': 'streamin-api/1.0' } }, { timeoutMs: env.XUI_REQUEST_TIMEOUT_MS });
  const [streams, categories] = await Promise.all([load('get_live_streams'), load('get_live_categories')]);
  if (!Array.isArray(streams) || streams.length > 50000 || !Array.isArray(categories) || categories.length > 5000) throw fail('Live TV channels unavailable', 503);
  return { streams: streams.map(row => ({ stream_id: row.stream_id, category_id: row.category_id, name: row.name, is_adult: row.is_adult, stream_type: row.stream_type })),
    categories: categories.map(row => ({ category_id: row.category_id, category_name: row.category_name })) };
}
function createSportsChannelResolver({ loadEvents = getSportsEvents,
  readSettings = device => require('./movieSettings.cjs').readMovieSettings(device),
  getUpstream = device => require('./upstreamAuth.cjs').getDeviceUpstream(device), loadCatalog = fetchLiveCatalog,
  loadEpg = fetchSportsEpg, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), epgCache = new Map(), epgPending = new Map();
  async function guide(key, upstream, id) {
    const cacheKey = `${key}:${id}`, saved = epgCache.get(cacheKey);
    if (saved && now() - saved.at < 120000) return saved.rows;
    if (epgPending.has(cacheKey)) return epgPending.get(cacheKey);
    if (epgPending.size >= 4) return [];
    const request = Promise.resolve().then(() => loadEpg(upstream, id)).catch(() => []).then(rows => {
      if (epgCache.size >= 800) epgCache.delete(epgCache.keys().next().value);
      epgCache.set(cacheKey, { at: now(), rows }); return rows;
    }).finally(() => epgPending.delete(cacheKey));
    epgPending.set(cacheKey, request); return request;
  }
  return async (device, eventId) => {
    if (typeof eventId !== 'string' || !eventId || eventId.length > 100) throw fail('Invalid sports event');
    const settings = await readSettings(device);
    if (settings.live_tv_enabled === false) throw fail('Live TV is disabled for this device', 403);
    const snapshot = await loadEvents();
    const event = snapshot.events.find(value => value.id === eventId);
    if (!event) throw fail('This event is no longer listed. Refresh the schedule.', 404);
    const upstream = await getUpstream(device);
    if (!upstream) throw fail('No Live TV account configured for this device', 404);
    // Device plus upstream identity prevents sharing subscription channel lists across accounts.
    const key = createHash('sha256').update(JSON.stringify([device, upstream.upstream_base_url, upstream.username, upstream.password])).digest('hex');
    for (const [id, entry] of cache) if (now() - entry.at >= 120000) cache.delete(id);
    let catalog = cache.get(key)?.catalog;
    if (!catalog) {
      if (!pending.has(key)) {
        if (pending.size >= 8) throw fail('Live TV channels are busy. Try again.', 503);
        const request = Promise.resolve().then(() => loadCatalog(upstream)).then(value => {
          if (!Array.isArray(value?.streams) || !Array.isArray(value?.categories)) throw fail('Live TV channels unavailable', 503);
          if (cache.size >= 20) cache.delete(cache.keys().next().value);
          cache.set(key, { at: now(), catalog: value }); return value;
        }).finally(() => pending.delete(key));
        pending.set(key, request);
      }
      catalog = await pending.get(key);
    }
    const channels = matchSportsChannels(event.broadcasters || [], catalog.streams, catalog.categories, settings.sports_broadcaster_aliases || []);
    if (!channels.length && (event.homeTeam && event.awayTeam || /\s+(?:vs\.?|v|versus)\s+/i.test(event.title || ''))) {
      const sports = new Set(catalog.categories.filter(row => /sport|nfl|nba|nhl|cricket|football|soccer|hockey|basketball|baseball|rugby|tennis/i.test(row.category_name || ''))
        .map(row => String(row.category_id)));
      const candidates = eligibleStreams(catalog.streams, catalog.categories).filter(row => sports.has(String(row.category_id)) ||
        /\b(?:tsn|espn|tnt sports|bein|sky sports|nfl|cbs|fox|nbc|sportsnet)\b/i.test(row.name)).slice(0, 60);
      let index = 0;
      const deadline = Date.now() + 6000;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (index < candidates.length && Date.now() < deadline) {
          const stream = candidates[index++];
          const rows = await guide(key, upstream, String(stream.stream_id));
          if (epgMatchesEvent(event, rows)) channels.push({ stream_id: String(stream.stream_id), category_id: String(stream.category_id),
            name: stream.name, broadcaster: 'Program guide match', match_type: 'epg' });
        }
      }));
      channels.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    return { event_id: eventId, channels };
  };
}
module.exports = { channelName, normalizeSportsAliases, matchSportsChannels, createSportsChannelResolver, resolveSportsChannels: createSportsChannelResolver() };
