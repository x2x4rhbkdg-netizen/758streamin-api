const { readText, validateUrl } = require('./scraperHttp.cjs');
const { createHash } = require('node:crypto');
const cache = new Map();
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function normalizeAddons(input, previous = []) {
  if (!Array.isArray(input) || input.length > 10) invalid('Configure at most 10 Stremio add-ons');
  const ids = new Set(), urls = new Set();
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Invalid add-on');
    const id = String(item.id || '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) invalid('Invalid or duplicate add-on ID');
    ids.add(id);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > 80) invalid('Add-on name must be 1 to 80 characters');
    const manifest_url = Object.hasOwn(item, 'manifest_url') ? String(item.manifest_url || '').trim() : previous.find((a) => a.id === id)?.manifest_url;
    let url;
    try { url = validateUrl(manifest_url); } catch { invalid('Invalid add-on manifest URL'); }
    if (url.protocol !== 'https:' || !url.pathname.endsWith('/manifest.json') || url.hash || url.search) invalid('Add-on URL must be HTTPS and end in /manifest.json without a query');
    if (urls.has(url.href)) invalid('Duplicate add-on manifest URL');
    urls.add(url.href);
    if (typeof item.enabled !== 'boolean' || !Array.isArray(item.scopes) || !item.scopes.length ||
      item.scopes.some((s) => !['movie', 'series', 'anime'].includes(s))) invalid('Invalid add-on enabled state or scopes');
    return { id, name, manifest_url: url.href, enabled: item.enabled, scopes: [...new Set(item.scopes)] };
  });
}
function publicAddons(addons = []) {
  return addons.map(({ id, name, enabled, scopes }) => ({ id, name, enabled, scopes, manifest_configured: true }));
}
async function json(url, fetchText, signal) {
  const key = createHash('sha256').update(url).digest('hex');
  const hit = cache.get(key);
  if (fetchText === readText && hit?.expires > Date.now()) return hit.data;
  const data = JSON.parse(await fetchText(url, { signal }));
  if (fetchText === readText) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expires: Date.now() + 60000 });
  }
  return data;
}
function supports(manifest, type, id) {
  if (!manifest || typeof manifest.id !== 'string' || !Array.isArray(manifest.resources) || !Array.isArray(manifest.types)) return false;
  return manifest.resources.some((resource) => {
    const r = typeof resource === 'string' ? { name: resource } : resource;
    return r?.name === 'stream' && (r.types || manifest.types).includes(type) &&
      (!(r.idPrefixes || manifest.idPrefixes)?.length || (r.idPrefixes || manifest.idPrefixes).some((prefix) => id.startsWith(prefix)));
  });
}
async function testAddon(addon, { fetchText = readText } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const manifest = await json(addon.manifest_url, fetchText, controller.signal);
    const supported = ['tt1254207', 'kitsu:1:1'].filter((id) => ['movie', 'series', ...(id.startsWith('kitsu:') ? ['anime'] : [])].some((type) => supports(manifest, type, id)));
    if (!supported.length) {
      return { status: 'unsupported', message: 'No supported IMDb or Kitsu stream resource' };
    }
    return { status: 'connected', message: `${supported.map((id) => id.startsWith('kitsu:') ? 'Kitsu' : 'IMDb').join(' / ')} stream resource available` };
  } catch { return { status: 'unavailable', message: 'Manifest could not be loaded or validated' }; }
  finally { clearTimeout(timer); }
}
async function discoverAddons(settings, query, { fetchText = readText } = {}) {
  const addons = (settings.stremio_addons || []).filter((a) => a.enabled && a.scopes.includes(query.section === 'anime' ? 'anime' : query.type));
  const results = new Array(addons.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, addons.length) }, async () => {
    while (cursor < addons.length) {
      const index = cursor++, addon = addons[index];
      const diagnostic = { id: addon.id, name: addon.name, status: 'unavailable', sources: 0, unsupported: 0 };
      const sources = [];
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        if (!query.stream_id && !query.imdb_id) { diagnostic.status = 'missing_identifier'; results[index] = { sources, diagnostic }; continue; }
        const id = query.stream_id || (query.type === 'series' ? `${query.imdb_id}:${query.season_int}:${query.episode_int}` : query.imdb_id);
        const manifest = await json(addon.manifest_url, fetchText, controller.signal);
        const type = supports(manifest, query.type, id) ? query.type : query.kitsu_id && supports(manifest, 'anime', id) ? 'anime' : null;
        if (!type) { diagnostic.status = 'unsupported'; results[index] = { sources, diagnostic }; continue; }
        const base = addon.manifest_url.slice(0, -'manifest.json'.length);
        const response = await json(`${base}stream/${type}/${encodeURIComponent(id)}.json`, fetchText, controller.signal);
        if (!Array.isArray(response.streams)) throw new Error('Invalid stream response');
        for (const stream of response.streams.slice(0, 100)) {
          const hash = String(stream?.infoHash || '').toLowerCase();
          if (!/^[a-f0-9]{40}$/.test(hash)) { diagnostic.unsupported++; continue; }
          const title = String(stream.behaviorHints?.filename || stream.description || stream.title || stream.name || query.title).slice(0, 500);
          const size = Number(stream.behaviorHints?.videoSize);
          sources.push({ hash, magnet: `magnet:?xt=urn:btih:${hash}`, title, scraper: addon.name,
            ...(query.kitsu_id && typeof stream.behaviorHints?.filename === 'string' ? { file_name: stream.behaviorHints.filename.slice(0, 500) } : {}),
            quality: /\b(2160|1080|720|480)p\b/i.exec(`${stream.name || ''} ${title}`)?.[0] || (/\b4k\b/i.test(`${stream.name || ''} ${title}`) ? '2160p' : ''),
            size_bytes: Number.isFinite(size) && size > 0 ? size : 0, seeders: 0, bitrate_mbps: null });
        }
        diagnostic.status = 'ok'; diagnostic.sources = sources.length;
      } catch { /* Diagnostics must never include upstream URLs or credentials. */ }
      finally { clearTimeout(timer); }
      results[index] = { sources, diagnostic };
    }
  }));
  return { sources: results.flatMap((r) => r.sources), diagnostics: results.map((r) => r.diagnostic) };
}
module.exports = { normalizeAddons, publicAddons, supports, testAddon, discoverAddons };
