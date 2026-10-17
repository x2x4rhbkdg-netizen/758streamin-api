const { createHash } = require('node:crypto');

const entries = new Map();
const TTL = 15 * 60 * 1000;
const LIMIT = 120;
const featured = [/^Netflix$/i, /^(Amazon )?Prime Video$/i, /^Hulu$/i, /^Apple TV\+$/i, /^Disney\+$/i, /^(HBO )?Max$/i, /^Paramount\+$/i, /^Peacock/i];
function rank(name) { const index = featured.findIndex(pattern => pattern.test(name)); return index < 0 ? featured.length : index; }
function cached(key, run) {
  const previous = entries.get(key);
  if (previous && previous.expires > Date.now()) return previous.value;
  if (entries.size >= LIMIT) entries.delete(entries.keys().next().value);
  const value = Promise.resolve().then(run);
  entries.set(key, { expires: Date.now() + TTL, value });
  value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
  return value;
}
function scope(settings) {
  return createHash('sha256').update(settings.tmdb_read_access_token || '').digest('hex');
}
async function workers(values, run) {
  const results = new Array(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (index < values.length) {
      const current = index++;
      try { results[current] = { value: await run(values[current]) }; }
      catch { results[current] = { failed: true }; }
    }
  }));
  return results;
}
function services(settings, endpoint, request) {
  return cached(`${scope(settings)}:services:${endpoint}`, async () => {
    const data = await request(settings, `watch/providers/${endpoint}`);
    const providers = (Array.isArray(data.results) ? data.results : []).filter(value => Number.isInteger(value.provider_id))
      .map(value => ({ id: value.provider_id, name: value.provider_name || '',
        logo: typeof value.logo_path === 'string' && /^\/[a-zA-Z0-9_.-]+$/.test(value.logo_path)
          ? `https://image.tmdb.org/t/p/w92${value.logo_path}` : null,
        regions: Object.keys(value.display_priorities || {}).filter(region => /^[A-Z]{2}$/.test(region)),
      }));
    const groups = new Map();
    for (const provider of providers) {
      const key = provider.name.trim().replace(/\s+/g, ' ').toLowerCase();
      const previous = groups.get(key);
      if (!previous) groups.set(key, { ...provider, ids: [provider.id] });
      else {
        previous.ids = [...new Set([...previous.ids, provider.id])].sort((a, b) => a - b);
        previous.id = previous.ids[0];
        previous.regions = [...new Set([...previous.regions, ...provider.regions])];
        if (!previous.logo) previous.logo = provider.logo;
      }
    }
    return [...groups.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  });
}
async function browse(settings, endpoint, request, { service, page, category, query }) {
  const list = await services(settings, endpoint, request);
  const selected = list.find(value => value.ids.includes(service));
  if (!selected) throw Object.assign(new Error('Streaming service unavailable'), { status: 400 });
  const regions = await cached(`${scope(settings)}:regions`, async () => {
    const data = await request(settings, 'watch/providers/regions');
    return (data.results || []).map(value => value.iso_3166_1).filter(value => /^[A-Z]{2}$/.test(value));
  });
  return cached(`${scope(settings)}:${endpoint}:${service}:${page}:${category}:${query}`, async () => {
    if (query) {
      const data = await request(settings, `search/${endpoint}`, { query, page, include_adult: false });
      const checked = await workers((data.results || []).filter(title => !title.adult), async title => {
        const availability = await cached(`${scope(settings)}:availability:${endpoint}:${title.id}`,
          () => request(settings, `${endpoint}/${title.id}/watch/providers`));
        const matches = Object.values(availability.results || {}).some(country =>
          ['flatrate', 'free', 'ads', 'rent', 'buy'].some(kind => (country[kind] || []).some(provider => selected.ids.includes(provider.provider_id))));
        return matches ? title : null;
      });
      if (checked.some(result => result.failed)) throw new Error('Streaming service search temporarily unavailable');
      return { results: checked.map(result => result.value).filter(Boolean), total_pages: Math.min(500, Number(data.total_pages) || 1) };
    }
    const pages = await workers(regions, region => request(settings, `discover/${endpoint}`, {
      page, include_adult: false, watch_region: region, with_watch_providers: selected.ids.join('|'),
      sort_by: category === 'top_rated' ? 'vote_average.desc' : 'popularity.desc',
      ...(category === 'top_rated' ? { 'vote_count.gte': 200 } : {}),
    }));
    const successful = pages.filter(value => !value.failed);
    if (!successful.length) throw new Error('Streaming service catalog temporarily unavailable');
    const unique = new Map();
    for (const { value } of successful) for (const title of value.results || []) {
      if (!title.adult && Number.isInteger(title.id)) unique.set(title.id, title);
    }
    const results = [...unique.values()]
      .sort((a, b) => Number(category === 'top_rated' ? b.vote_average : b.popularity) - Number(category === 'top_rated' ? a.vote_average : a.popularity) || a.id - b.id);
    return { results, total_pages: Math.min(500, Math.max(1, ...successful.map(({ value }) => Number(value.total_pages) || 1))),
      ...(successful.length < regions.length ? { notice: 'Some regions are temporarily unavailable.' } : {}) };
  });
}
module.exports = { services, browse };
