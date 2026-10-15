const cheerio = require('cheerio');
const { readText } = require('./scraperHttp.cjs');
const { discoverAddons } = require('./stremioAddons.cjs');
const { kitsuId } = require('./kitsuCatalog.cjs');

const MAX_DEFINITIONS = 48;
const MAX_RESULTS = 100;
const manifestCache = new Map();
const definitionCache = new Map();

function validateSearch(input) {
  if (!input || !['movie', 'series'].includes(input.type)) throw Object.assign(new Error('type must be movie or series'), { status: 400 });
  const title = String(input.title || '').trim();
  const imdb_id = String(input.imdb_id || '').trim();
  const kitsu = input.section === 'anime' && kitsuId(input.kitsu_id);
  if ((!title && !imdb_id && !kitsu) || title.length > 200 || (imdb_id && !/^tt\d{5,12}$/.test(imdb_id))) {
    throw Object.assign(new Error('Valid title or IMDb ID required'), { status: 400 });
  }
  const result = { type: input.type, title, title_lower: title.toLowerCase(), imdb_id };
  if (input.section != null) {
    if (input.section !== 'anime' || (!kitsu && (!Number.isInteger(input.tmdb_id) || input.tmdb_id < 1 || input.tmdb_id > 2147483647))) {
      throw Object.assign(new Error('Anime requires a valid TMDB identifier'), { status: 400 });
    }
    result.section = 'anime';
    if (kitsu) {
      result.kitsu_id = input.kitsu_id;
      if (input.type === 'series' && (typeof input.video_id !== 'string' ||
        !(input.video_id === input.kitsu_id || new RegExp(`^${input.kitsu_id}:[1-9]\\d{0,4}$`).test(input.video_id)))) invalidKitsu();
      result.video_id = input.video_id;
      // Only server-canonical metadata may carry the upstream stream identity.
      if (input.stream_id) result.stream_id = input.stream_id;
      if (Number.isInteger(input.absolute_episode)) result.absolute_episode = input.absolute_episode;
      if (Number.isInteger(input.mapped_season)) result.mapped_season = input.mapped_season;
      if (Number.isInteger(input.mapped_episode)) result.mapped_episode = input.mapped_episode;
    } else result.tmdb_id = input.tmdb_id;
  }
  for (const [key, min, max] of [['year_int', 1800, 2200], ['season_int', 0, 1000], ['episode_int', 1, 10000]]) {
    if (input[key] != null) {
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw Object.assign(new Error(`Invalid ${key}`), { status: 400 });
      result[key] = value;
    }
  }
  if (result.type === 'series' && (result.season_int == null || result.episode_int == null)) {
    throw Object.assign(new Error('Season and episode are required'), { status: 400 });
  }
  if (input.duration_seconds != null) {
    const duration = Number(input.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 36000) throw Object.assign(new Error('Invalid duration_seconds'), { status: 400 });
    result.duration_seconds = duration;
  }
  return result;
}
function invalidKitsu() { throw Object.assign(new Error('Invalid Anime episode identifier'), { status: 400 }); }

function searchUrl(definition, query) {
  const format = definition[query.type === 'movie' ? 'search_url_format_movie' : 'search_url_format_episode'];
  if (!format?.string_format || !Array.isArray(format.replacement)) throw new Error('Unsupported content type');
  let index = 0;
  const relative = format.string_format.replace(/%(?:0(\d{1,2}))?([sd])/g, (_, width, type) => {
    const key = format.replacement[index++];
    const value = query[key];
    if (value == null || value === '') throw new Error('Search metadata missing');
    return type === 'd' ? String(Number(value)).padStart(Number(width || 0), '0') : encodeURIComponent(String(value));
  });
  if (index !== format.replacement.length || /%(?![0-9a-f]{2})/i.test(relative)) throw new Error('Unsupported search format');
  return new URL(relative, definition.base_url).href;
}

function atPath(value, path) {
  if (!path) return undefined;
  return String(path).split(/\{\}|\./).filter(Boolean).reduce((current, key) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) return undefined;
    return current?.[key];
  }, value);
}

function source(item, name) {
  let hash = String(item.hash || '').trim().toLowerCase();
  if (!hash && item.magnet) {
    try { hash = String(new URL(item.magnet).searchParams.get('xt') || '').replace(/^urn:btih:/i, '').toLowerCase(); } catch {}
  }
  // BEP-3 hexadecimal hashes only; unsupported formats are reported by the scraper diagnostics.
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;
  const title = String(item.title || '').slice(0, 500);
  const quality = String(item.quality || (/\b(2160|1080|720|480)p\b/i.exec(title)?.[0]) || '').slice(0, 40);
  return { hash, magnet: `magnet:?xt=urn:btih:${hash}`, title,
    scraper: String(name || 'Scraper').slice(0, 80), seeders: Math.max(0, Number(item.seeders) || 0),
    size_bytes: Math.max(0, Number(item.size_bytes) || 0), quality,
    bitrate_mbps: Number.isFinite(Number(item.bitrate_mbps)) && Number(item.bitrate_mbps) > 0 ? Number(item.bitrate_mbps) : null };
}

function parseApi(definition, text) {
  const data = JSON.parse(text);
  const api = definition.api;
  const parents = api.path_to_base_array ? atPath(data, api.path_to_base_array) : [data];
  if (!Array.isArray(parents)) return [];
  return parents.flatMap((parent) => {
    const items = atPath(parent, api.path_to_array);
    if (!Array.isArray(items)) return [];
    return items.slice(0, MAX_RESULTS).map((item) => source({
      hash: atPath(item, api.path_hash),
      title: atPath(item, api.path_title_in_array || api.path_title) || atPath(parent, api.path_title),
      seeders: atPath(item, api.path_seeders), size_bytes: atPath(item, api.path_size), quality: atPath(item, api.path_quality),
      bitrate_mbps: api.path_bitrate_mbps ? atPath(item, api.path_bitrate_mbps) : null,
    }, definition.name)).filter(Boolean);
  }).slice(0, MAX_RESULTS);
}

function htmlValue($, row, definition, key, pageUrl) {
  let selector = definition[`${key}_path`];
  if (typeof selector !== 'string' || !selector) return '';
  if (/^\|\w+_path\|$/.test(selector)) selector = definition[selector.slice(1, -1)];
  if (!selector || selector.length > 500) return '';
  const element = row.find(selector).first();
  const attribute = definition[`${key}_path_attr`] || '';
  if (!attribute || attribute === '|HTML|') return element.text().trim();
  const value = element.attr(attribute.replace(/^abs:/, '')) || '';
  return attribute.startsWith('abs:') && value ? new URL(value, pageUrl).href : value;
}

function parseHtml(definition, text, pageUrl) {
  const $ = cheerio.load(text);
  const rows = definition.links_container_path ? $(definition.links_container_path).slice(0, MAX_RESULTS) : $.root();
  return rows.toArray().map((element) => {
    const row = $(element);
    return source({ magnet: htmlValue($, row, definition, 'magnet', pageUrl),
      title: htmlValue($, row, definition, 'title', pageUrl), seeders: htmlValue($, row, definition, 'seeders', pageUrl),
      quality: htmlValue($, row, definition, 'quality', pageUrl) }, definition.name);
  }).filter(Boolean);
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { ok: true, value: await run(items[index]) }; }
      catch { results[index] = { ok: false }; }
    }
  }));
  return results;
}

async function loadDefinitionLinks(url, fetchText, signal) {
  const cached = manifestCache.get(url);
  if (fetchText === readText && cached?.expires > Date.now()) return cached.value;
  const manifest = JSON.parse(await fetchText(url, { signal }));
  const links = Array.isArray(manifest) ? manifest : Object.values(manifest).flat();
  const unique = [...new Set(links.filter((link) => typeof link === 'string'))].slice(0, MAX_DEFINITIONS);
  if (!unique.length) throw new Error('Invalid WEYD manifest');
  if (fetchText === readText && !signal.aborted) {
    if (manifestCache.size >= 10) manifestCache.delete(manifestCache.keys().next().value);
    manifestCache.set(url, { expires: Date.now() + 300000, value: unique });
  }
  return unique;
}

async function loadDefinitions(urls, fetchText, signal) {
  const manifests = await mapLimit(urls, 2, (url) => loadDefinitionLinks(url, fetchText, signal));
  const packs = manifests.filter((entry) => entry.ok).map((entry) => entry.value);
  const unique = [], seen = new Set();
  // Alternate packs so the second does not sit behind every definition in the first.
  for (let index = 0; index < MAX_DEFINITIONS; index++) {
    for (const pack of packs) {
      const link = pack[index];
      if (link && !seen.has(link)) { seen.add(link); unique.push(link); }
    }
  }
  // Share the definition budget across packs, including definitions referenced by both.
  const loaded = await mapLimit(unique, 4, async (link) => {
    if (signal.aborted) throw new Error('Search timed out');
    const cached = definitionCache.get(link);
    if (fetchText === readText && cached?.expires > Date.now()) return cached.value;
    const definition = JSON.parse(await fetchText(link, { signal }));
    if (!definition || typeof definition.base_url !== 'string' || Object.entries(definition).some(([key, value]) =>
      key.endsWith('_path') && (typeof value !== 'string' || value.length > 500))) throw new Error('Invalid scraper definition');
    if (fetchText === readText && !signal.aborted) {
      if (definitionCache.size >= 500) definitionCache.delete(definitionCache.keys().next().value);
      definitionCache.set(link, { expires: Date.now() + 300000, value: definition });
    }
    return definition;
  });
  const definitions = loaded.filter((entry) => entry.ok && entry.value?.is_torrent === true).map((entry) => entry.value);
  return { definitions, definition_errors: loaded.filter((entry) => !entry.ok).length + manifests.filter((entry) => !entry.ok).length };
}

async function discoverSources(settings, input, { fetchText = readText } = {}) {
  const query = validateSearch(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const addonPromise = discoverAddons(settings, query, { fetchText });
    const urls = query.kitsu_id ? [] : [...new Set([settings.scraper_url, settings.secondary_scraper_url].filter(Boolean))];
    const loaded = await loadDefinitions(urls, fetchText, controller.signal);
    const definitions = loaded.definitions;
    const results = await mapLimit(definitions, 4, async (definition) => {
      if (controller.signal.aborted) throw new Error('Search timed out');
      const url = searchUrl(definition, query);
      const text = await fetchText(url, { signal: controller.signal });
      if (definition.api) return parseApi(definition, text);
      if (definition.links_on_first_page !== false) return parseHtml(definition, text, url);
      const $ = cheerio.load(text);
      const links = $(definition.drill_down_path).slice(0, 4).toArray().map((element) => {
        const href = $(element).attr(String(definition.drill_down_path_attr || 'href').replace(/^abs:/, ''));
        return href ? new URL(href, url).href : null;
      }).filter(Boolean);
      const details = await mapLimit(links, 2, async (link) => parseHtml(definition, await fetchText(link, { signal: controller.signal }), link));
      return details.filter((entry) => entry.ok).flatMap((entry) => entry.value);
    });
    const addons = await addonPromise;
    const excluded = String(settings.hide_phrases || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const deduplicated = new Map();
    const scraperSources = results.filter((entry) => entry.ok).flatMap((entry) => entry.value);
    const addonSources = new Set(addons.sources);
    for (const result of [...scraperSources, ...addons.sources]) {
      const canonical = (value) => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const wanted = canonical(query.title);
      if (!addonSources.has(result) && wanted && !(` ${canonical(result.title)} `).includes(` ${wanted} `)) continue;
      if (!addonSources.has(result) && query.type === 'movie' && query.year_int != null && !new RegExp(`\\b${query.year_int}\\b`).test(result.title)) continue;
      if (excluded.some((phrase) => result.title.toLowerCase().includes(phrase))) continue;
      if (!result.bitrate_mbps && result.size_bytes && query.duration_seconds) result.bitrate_mbps = result.size_bytes * 8 / query.duration_seconds / 1000000;
      if (result.bitrate_mbps && (result.bitrate_mbps < Number(settings.min_bitrate_mbps || 0) || result.bitrate_mbps > Number(settings.max_bitrate_mbps || 100))) continue;
      if (!addonSources.has(result) && query.type === 'series') {
        const episode = /s(\d{1,3})e(\d{1,4})/i.exec(result.title);
        if (!episode || Number(episode[1]) !== query.season_int || Number(episode[2]) !== query.episode_int) continue;
      }
      if (!deduplicated.has(result.hash)) deduplicated.set(result.hash, result);
    }
    // Discovery is already bounded per scraper. Do not discard lower resolutions before cache checks.
    return { sources: [...deduplicated.values()].sort((a, b) => compareSources(a, b, settings)),
      diagnostics: { scrapers: definitions.length, failed: results.filter((entry) => !entry.ok).length,
        definition_errors: loaded.definition_errors || 0, timed_out: controller.signal.aborted,
        addons: addons.diagnostics },
      playable: false };
  } finally { clearTimeout(timer); }
}

function compareSources(a, b, settings) {
  const metric = (item, key) => key === 'quality' ? (Number(/(2160|1080|720|480)/.exec(item.quality)?.[1]) || null) :
    key === 'bitrate' ? item.bitrate_mbps : key === 'size' ? item.size_bytes || null : item.seeders;
  for (const level of ['primary', 'secondary']) {
    const key = settings[`${level}_sort`] || (level === 'primary' ? 'quality' : 'bitrate');
    const left = metric(a, key), right = metric(b, key);
    if (left == null && right != null) return 1;
    if (right == null && left != null) return -1;
    if (left != null && right != null && left !== right) return (left - right) * (settings[`${level}_sort_direction`] === 'asc' ? 1 : -1);
  }
  return b.seeders - a.seeders;
}

module.exports = { discoverSources, validateSearch, searchUrl, parseApi, parseHtml, mapLimit, compareSources };
