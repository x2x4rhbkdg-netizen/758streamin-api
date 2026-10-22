const { createHash } = require('node:crypto');
const { validateUrl } = require('./scraperHttp.cjs');
const ID = '__tpdb';
const KINDS = ['scenes', 'movies', 'jav'];
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
function provider(settings) {
  return settings.theporndb_enabled === true && settings.theporndb_token
    ? { id: ID, manifest_url: `theporndb:v1:${createHash('sha256').update(settings.theporndb_token).digest('hex')}` } : null;
}
function image(value) {
  try { const url = validateUrl(value); return url.protocol === 'https:' && !url.hash ? url.href : undefined; }
  catch { return undefined; }
}
function normalizeItem(value, kind) {
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.id) || typeof value.title !== 'string' || !value.title.trim()) return null;
  return { id: `tpdb:${kind}:${value.id}`, type: 'movie', title: value.title.slice(0, 300),
    overview: typeof value.description === 'string' ? value.description.slice(0, 2000) : '',
    poster: image(value.poster) || image(value.posters?.large) || image(value.poster_image) || image(value.image),
    tpdb_kind: kind, tpdb_id: value.id,
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value.date || '') && Number(value.date.slice(0, 4)) >= 1800 && Number(value.date.slice(0, 4)) <= 2200
      ? { year: Number(value.date.slice(0, 4)) } : {}) };
}
function parseItem(item) {
  if (!KINDS.includes(item.tpdb_kind) || typeof item.tpdb_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.tpdb_id) ||
      item.id !== `tpdb:${item.tpdb_kind}:${item.tpdb_id}`) throw fail('Invalid ThePornDB title', 400);
}
function createThePornDbClient({ fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), cooldowns = new Map();
  let active = 0;
  async function request(token, path, fresh = false) {
    if (typeof token !== 'string' || !token || token.length > 8192 || /[^\x21-\x7e]/.test(token)) throw fail('Configure a valid ThePornDB token in Media Settings', 409);
    const url = new URL(path, 'https://api.theporndb.net');
    if (url.origin !== 'https://api.theporndb.net' || !/^\/(scenes|movies|jav)(\/[a-zA-Z0-9_-]+)?$/.test(url.pathname)) throw fail('Invalid ThePornDB request', 400);
    const owner = createHash('sha256').update(token).digest('hex'), key = `${owner}:${url.href}`;
    const hit = cache.get(key);
    if (!fresh && hit?.expires > now()) return hit.data;
    if (cooldowns.get(owner) > now()) throw fail('ThePornDB is rate limited. Try again shortly.', 429);
    if (pending.has(key)) return pending.get(key);
    if (active >= 4) throw fail('ThePornDB is busy. Try again shortly.', 429);
    const run = (async () => {
      active++;
      try {
        const response = await fetcher(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        if (response.status === 429) {
          if (cooldowns.size >= 100) cooldowns.delete(cooldowns.keys().next().value);
          const retry = Number(response.headers.get('retry-after'));
          cooldowns.set(owner, now() + Math.min(300, Math.max(1, Number.isFinite(retry) && retry > 0 ? retry : 60)) * 1000);
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status)) throw fail('ThePornDB rejected its configured token. Check Media Settings.', 409);
          if (response.status === 404) throw fail('ThePornDB title not found', 404);
          if (response.status === 429) throw fail('ThePornDB is rate limited. Try again shortly.', 429);
          throw fail('ThePornDB is temporarily unavailable');
        }
        if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw fail('Invalid ThePornDB response');
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw fail('ThePornDB response too large'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'data')) throw fail('Invalid ThePornDB response');
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { data, expires: now() + 300000 });
        return data;
      } catch (error) { if (error.status) throw error; throw fail('ThePornDB is temporarily unavailable'); }
      finally { active--; }
    })();
    pending.set(key, run);
    try { return await run; } finally { pending.delete(key); }
  }
  return {
    async test(token) {
      const data = await request(token, '/scenes?per_page=1&page=1', true);
      if (!Array.isArray(data.data)) throw fail('Invalid ThePornDB catalog response');
      return { status: 'connected', message: 'ThePornDB catalog connected. Playback sources are configured separately.' };
    },
    catalogs() {
      return KINDS.map(id => ({ addon_id: ID, id, type: 'movie', name: id === 'jav' ? 'JAV' : id === 'movies' ? 'Movies' : 'Scenes', addon_name: 'ThePornDB', search_supported: true }));
    },
    async catalog(settings, input) {
      if (!provider(settings)) throw fail('ThePornDB is not enabled', 409);
      if (!KINDS.includes(input.catalog_id) || input.type !== 'movie') throw fail('Invalid ThePornDB catalog', 400);
      const page = Number(input.page || 1);
      if (!Number.isInteger(page) || page < 1 || page > 100) throw fail('Invalid catalog page', 400);
      if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200)) throw fail('Invalid catalog search', 400);
      const params = new URLSearchParams({ page: String(page), per_page: '25', orderBy: 'recently_released' });
      if (input.query?.trim()) { params.set('q', input.query.trim()); params.set('orderBy', 'most_relevant'); }
      const result = await request(settings.theporndb_token, `/${input.catalog_id}?${params}`);
      if (!Array.isArray(result.data)) throw fail('Invalid ThePornDB catalog response');
      return { items: result.data.slice(0, 25).map(value => normalizeItem(value, input.catalog_id)).filter(Boolean),
        has_more: page < 100 && Number.isInteger(result.meta?.last) && result.meta.last > page };
    },
    async details(settings, item) {
      parseItem(item);
      const result = await request(settings.theporndb_token, `/${item.tpdb_kind}/${encodeURIComponent(item.tpdb_id)}`);
      const mapped = normalizeItem(result.data, item.tpdb_kind);
      if (!mapped || mapped.id !== item.id) throw fail('ThePornDB title not found', 404);
      return { ...item, ...mapped, videos: [] };
    },
  };
}
module.exports = { ID, provider, parseItem, createThePornDbClient };
