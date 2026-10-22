const { readText, validateUrl } = require('./scraperHttp.cjs');
const { createHash } = require('node:crypto');
const addonVersion = (addon) => createHash('sha256').update(String(addon.manifest_url || '')).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const bounded = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : '';
function resource(manifest, name, type, id = '') {
  return manifest.resources.some((entry) => {
    const item = typeof entry === 'string' ? { name: entry } : entry;
    const prefixes = item?.idPrefixes || manifest.idPrefixes;
    return item?.name === name && (item.types || manifest.types).includes(type) &&
      (!id || !prefixes?.length || prefixes.some((prefix) => id.startsWith(prefix)));
  });
}
function adultCatalogs(data) {
  return (Array.isArray(data.catalogs) ? data.catalogs : []).filter((catalog) =>
    catalog && typeof catalog.type === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(catalog.type) && data.types.includes(catalog.type) &&
    typeof catalog.id === 'string' && catalog.id.length > 0 && catalog.id.length <= 200 &&
    resource(data, 'catalog', catalog.type) && resource(data, 'stream', catalog.type) &&
    !(catalog.extra || []).some((extra) => extra.isRequired && extra.name !== 'search'));
}
function adultAddons(settings) {
  return (settings.stremio_addons || []).filter((addon) => addon.enabled && addon.scopes.length === 1 && addon.scopes[0] === 'adult');
}
function selectedAddon(settings, id) {
  const addon = adultAddons(settings).find((entry) => entry.id === id);
  if (!addon) throw fail('Adult add-on is not enabled', 409);
  return addon;
}
function selectedItemAddon(settings, item) {
  const addon = selectedAddon(settings, item.addon_id);
  if (item.addon_version !== addonVersion(addon)) throw fail('Adult add-on changed. Open its catalog again.', 409);
  return addon;
}
function poster(value) {
  try { const url = validateUrl(value); return url.protocol === 'https:' && !url.hash ? url.href : undefined; }
  catch { return undefined; }
}
function createAdultAddonClient({ fetchText = readText } = {}) {
  const json = async (addon, path = 'manifest.json', signal) => {
    const base = addon.manifest_url.slice(0, -'manifest.json'.length);
    try { return JSON.parse(await fetchText(`${base}${path}`, { signal })); }
    catch { throw fail('Adult add-on unavailable. Check its manifest URL in Media Settings.', 502); }
  };
  const manifest = async (addon, signal) => {
    const result = await json(addon, 'manifest.json', signal);
    if (typeof result?.id !== 'string' || !Array.isArray(result.types) || !Array.isArray(result.resources)) throw fail('Invalid Adult add-on manifest', 502);
    return result;
  };
  const safeItem = (value, type) => {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 500) return null;
    return { id: value.id, type, title: bounded(value.name || value.id), overview: bounded(value.description, 2000), poster: poster(value.poster) };
  };
  async function streamSources(addon, type, id, signal) {
    const response = await json(addon, `stream/${type}/${encodeURIComponent(id)}.json`, signal);
    if (!Array.isArray(response.streams)) throw fail('Invalid Adult stream response', 502);
    const sources = [];
    for (const stream of response.streams.slice(0, 100)) {
      if (stream?.behaviorHints?.proxyHeaders || stream?.externalUrl) continue;
      const title = bounded(stream?.name || stream?.title || 'Source');
      const file_name = bounded(stream?.behaviorHints?.filename, 500);
      const hash = String(stream?.infoHash || '').toLowerCase();
      if (/^[a-f0-9]{40}$/.test(hash)) sources.push({ hash, title, ...(file_name ? { file_name } : {}) });
      else if (typeof stream?.url === 'string') {
        try {
          const url = validateUrl(stream.url);
          if (url.protocol === 'https:' && !url.hash && !/\.mpd$/i.test(url.pathname)) sources.push({ url: url.href, title });
        } catch { /* Unsupported streams cannot become playback capabilities. */ }
      }
    }
    return sources;
  }
  return {
    async catalogs(settings) {
      const addons = adultAddons(settings);
      if (!addons.length) throw fail('Enable an Adult Stremio add-on in Media Settings', 409);
      const results = [], diagnostics = [];
      // At most ten configured add-ons; fetch in small batches to bound upstream work.
      for (let start = 0; start < addons.length; start += 3) {
        await Promise.all(addons.slice(start, start + 3).map(async (addon) => {
          try {
            const data = await manifest(addon);
            adultCatalogs(data).slice(0, 30).forEach((catalog) => results.push({ addon_id: addon.id, id: catalog.id,
              type: catalog.type, name: bounded(catalog.name || catalog.id), addon_name: addon.name,
              search_supported: (catalog.extra || []).some((extra) => extra.name === 'search') || catalog.extraSupported?.includes('search') === true }));
            diagnostics.push({ id: addon.id, status: 'ok' });
          } catch { diagnostics.push({ id: addon.id, status: 'unavailable' }); }
        }));
      }
      if (!results.length) throw fail('No Adult catalog available from the configured add-ons', 502);
      return { catalogs: results, diagnostics };
    },
    async catalog(settings, input) {
      const addon = selectedAddon(settings, input.addon_id);
      const data = await manifest(addon);
      const catalog = adultCatalogs(data).find((entry) => entry.id === input.catalog_id && entry.type === input.type);
      if (!catalog) throw fail('Adult catalog unavailable', 404);
      const query = bounded(input.query, 200).trim();
      const page = Number(input.page || 1);
      if (!Number.isInteger(page) || page < 1 || page > 100) throw fail('Invalid catalog page');
      const extras = catalog.extra || (catalog.extraSupported || []).map((name) => ({ name }));
      if (!query && extras.some((extra) => extra.name === 'search' && extra.isRequired)) return { items: [], search_required: true };
      const parts = [];
      if (query) {
        if (!extras.some((extra) => extra.name === 'search')) throw fail('This catalog does not support search');
        parts.push(`search=${encodeURIComponent(query)}`);
      }
      const paginated = extras.some((extra) => extra.name === 'skip');
      if (page > 1 && !paginated) return { items: [] };
      if (paginated) parts.push(`skip=${(page - 1) * 100}`);
      const response = await json(addon, `catalog/${catalog.type}/${encodeURIComponent(catalog.id)}${parts.length ? `/${parts.join('&')}` : ''}.json`);
      if (!Array.isArray(response.metas)) throw fail('Invalid Adult catalog response', 502);
      return { items: response.metas.slice(0, 100).map((entry) => safeItem(entry, catalog.type)).filter(Boolean)
        .map((entry) => ({ ...entry, addon_id: addon.id, addon_version: addonVersion(addon) })), has_more: paginated && response.metas.length >= 100 };
    },
    async details(settings, item) {
      const addon = selectedItemAddon(settings, item);
      const data = await manifest(addon);
      if (!resource(data, 'meta', item.type, item.id)) return { ...item, videos: [] };
      const response = await json(addon, `meta/${item.type}/${encodeURIComponent(item.id)}.json`);
      if (response.meta?.id !== item.id) throw fail('Adult title unavailable', 404);
      return { ...item, overview: bounded(response.meta.description, 2000) || item.overview,
        videos: (Array.isArray(response.meta.videos) ? response.meta.videos : []).slice(0, 500)
          .filter((video) => typeof video.id === 'string' && video.id.length > 0 && video.id.length <= 500 &&
            (!video.released || Number.isFinite(Date.parse(video.released)) && Date.parse(video.released) <= Date.now()))
          .map((video) => ({ ...item, id: video.id, title: bounded(video.title || video.name || video.id),
            season: Number(video.season), episode: Number(video.episode) })) };
    },
    async sources(settings, item) {
      const addon = selectedItemAddon(settings, item);
      const data = await manifest(addon);
      if (!resource(data, 'stream', item.type, item.id)) throw fail('No supported stream resource for this title', 409);
      return streamSources(addon, item.type, item.id);
    },
    async metadataSources(settings, item) {
      const sources = [];
      const addons = adultAddons(settings).slice(0, 10);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      let cursor = 0;
      // An explicit prefix is required; an unrestricted manifest does not prove ID compatibility.
      try { await Promise.all(Array.from({ length: Math.min(3, addons.length) }, async () => {
        while (cursor < addons.length && !controller.signal.aborted) {
          const addon = addons[cursor++];
          try {
            const data = await manifest(addon, controller.signal);
            const compatible = data.resources.some(entry => {
              const r = typeof entry === 'string' ? { name: entry } : entry;
              const prefixes = r?.idPrefixes || data.idPrefixes;
              return r?.name === 'stream' && (r.types || data.types).includes('movie') &&
                Array.isArray(prefixes) && prefixes.some(prefix => typeof prefix === 'string' && /^tpdb:(scenes:|movies:|jav:)?$/.test(prefix) && item.id.startsWith(prefix));
            });
            if (!compatible) continue;
            sources.push(...(await streamSources(addon, 'movie', item.id, controller.signal)).map(source => ({ ...source,
              source_addon_id: addon.id, source_addon_version: addonVersion(addon) })));
          } catch { /* One unavailable source adapter must not prevent other configured adapters. */ }
        }
      })); } finally { clearTimeout(timer); }
      return sources.slice(0, 100);
    },
  };
}
module.exports = { createAdultAddonClient, adultAddons, addonVersion, adultCatalogs };
