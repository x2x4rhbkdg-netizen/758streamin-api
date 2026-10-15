const crypto = require('node:crypto');
const { createProviderScheduler, createAvailabilityCache } = require('./movieProviderScheduling.cjs');
const providerScheduler = createProviderScheduler();
const providerAvailability = createAvailabilityCache();
const SUPPORTED_PROVIDERS = ['Real-Debrid', 'Premiumize', 'Torbox', 'EasyDebrid', 'OffCloud'];
const transfers = new Map();
function failure(message, status = 409) { return Object.assign(new Error(message), { status, publicMessage: message }); }

function waitForProvider(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Provider preparation cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
const RD_FAILED = new Set(['magnet_error', 'error', 'virus', 'dead']);

function chooseVideo(files, input) {
  const videos = files.filter((file) => /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(file.path || '') && !/\bsample\b/i.test(file.path));
  if (input.section === 'adult' && input.file_name) {
    const basename = (value) => String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    const matched = videos.filter((file) => basename(file.path) === basename(input.file_name));
    if (matched.length !== 1) throw failure('No unambiguous matching file is available in this source');
    return matched[0];
  }
  if (input.section === 'anime' && input.kitsu_id) {
    const basename = (value) => String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    let matched;
    if (input.file_name) matched = videos.filter((file) => basename(file.path) === basename(input.file_name));
    else if (input.type === 'movie') matched = videos;
    else matched = videos.filter((file) => {
      const episode = /s(\d{1,3})e(\d{1,4})/i.exec(file.path) || /(\d{1,3})x(\d{1,4})/i.exec(file.path);
      if (episode) return Number(episode[1]) === (input.mapped_season ?? input.season_int) && Number(episode[2]) === (input.mapped_episode ?? input.episode_int);
      const absolute = /(?:\s-\s|^)(\d{1,4})(?:v\d+)?(?=[\s[.(]|$)/i.exec(basename(file.path));
      return absolute && Number(absolute[1]) === input.absolute_episode;
    });
    if (matched.length !== 1) throw failure('No unambiguous matching Anime episode is available in this source');
    return matched[0];
  }
  const matched = input.type === 'series' ? videos.filter((file) => {
    const episode = /s(\d{1,3})e(\d{1,4})/i.exec(file.path) || /(\d{1,3})x(\d{1,4})/i.exec(file.path);
    return episode && Number(episode[1]) === input.season_int && Number(episode[2]) === input.episode_int;
  }) : videos;
  const chosen = matched.sort((a, b) => Number(b.bytes || b.size || 0) - Number(a.bytes || a.size || 0))[0];
  if (!chosen) throw failure('No matching video file is available in this source');
  return chosen;
}

async function providerRequest(provider, token, path, form, signal) {
  const bases = { 'Real-Debrid': 'https://api.real-debrid.com/rest/1.0/', Premiumize: 'https://www.premiumize.me/api/', Torbox: 'https://api.torbox.app/v1/api/',
    EasyDebrid: 'https://easydebrid.com/api/v1/', OffCloud: 'https://offcloud.com/api/' };
  const url = new URL(path, bases[provider]);
  if (url.origin !== new URL(bases[provider]).origin) throw failure('Invalid provider endpoint', 400);
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (form && provider === 'Torbox') {
    body = new FormData();
    for (const [key, value] of Object.entries(form)) body.set(key, value);
  } else if (form && provider === 'EasyDebrid') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(form);
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (Array.isArray(value)) value.forEach((item) => parameters.append(`${key}[]`, item));
      else parameters.set(key, value);
    }
    body = parameters.toString();
  }
  if (provider === 'OffCloud') { url.searchParams.set('key', token); delete headers.Authorization; }
  // TorBox requires its token on requestdl; resolve server-side rather than exposing the credential to the app.
  if (provider === 'Torbox' && url.pathname.endsWith('/requestdl')) url.searchParams.set('token', token);
  const response = await fetch(url, { method: form ? 'POST' : 'GET', signal, redirect: 'error', headers, body });
  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    throw Object.assign(failure(rejected ? `${provider} rejected access. Check its token and account status in Media Settings.` : `${provider} could not resolve this source`, 502),
      { credentialRejected: rejected });
  }
  let text = '';
  if (response.status !== 204) {
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw failure(`${provider} response exceeded its limit`, 502);
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  const data = text ? JSON.parse(text) : {};
  if (provider === 'Torbox' && data.success !== true) throw failure('Torbox could not prepare this source', 502);
  if ((provider === 'OffCloud' && (data.error || data.not_available)) || (provider === 'Premiumize' && data.status !== 'success')) throw failure(`${provider} could not prepare this source`, 502);
  return data;
}

function configuredProviders(settings) {
  return SUPPORTED_PROVIDERS.filter((name) => settings.provider_accounts?.[name]?.enabled && settings.provider_accounts[name].token);
}

async function lookupProviders(settings, sources, { request = providerRequest, signal, availabilityCache } = {}) {
  const availability = availabilityCache || (request === providerRequest ? providerAvailability : null);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 8000);
  const available = {}, on_demand = {}, provider_status = {};
  // RD's account list is independent of the hash batch; fetch it only once per search.
  let rdList;
  const batchRequest = (...args) => {
    if (args[0] === 'Real-Debrid' && args[2] === 'torrents?limit=5000') return rdList ||= request(...args);
    return request(...args);
  };
  let cursor = 0;
  try {
    // Bound provider request sizes without limiting the resolutions shown in the app.
    await Promise.all(Array.from({ length: Math.min(2, Math.ceil(sources.length / 100)) }, async () => {
      while (cursor < sources.length && !controller.signal.aborted) {
        const batch = sources.slice(cursor, cursor += 100);
        const result = await lookupProviderBatch(settings, batch, { request: batchRequest, signal: controller.signal, availability });
        Object.assign(available, result.available);
        Object.assign(on_demand, result.on_demand);
        for (const [provider, status] of Object.entries(result.provider_status)) {
          const previous = provider_status[provider];
          provider_status[provider] = previous && previous !== status ? 'partial' : status;
        }
      }
    }));
    if (cursor < sources.length || controller.signal.aborted) {
      for (const provider of configuredProviders(settings)) provider_status[provider] = 'partial';
    }
    return { available, on_demand, provider_status };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function lookupProviderBatch(settings, sources, { request = providerRequest, signal, availability } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 8000);
  const available = {}, on_demand = {}, statuses = {};
  try {
    await Promise.all(configuredProviders(settings).map(async (provider) => {
      const token = settings.provider_accounts[provider].token;
      const call = (path, form) => request(provider, token, path, form, controller.signal);
      try {
        const previousError = availability?.error(provider, token);
        if (previousError) { statuses[provider] = previousError; return; }
        const known = sources.map((source) => availability?.get(provider, token, source.hash));
        const missing = sources.filter((_source, index) => known[index] === undefined);
        let cached;
        if (!missing.length) cached = [];
        else if (provider === 'Torbox') {
          const data = await call(`torrents/checkcached?hash=${missing.map((s) => s.hash).join(',')}&format=object&list_files=true`);
          cached = missing.map((s) => Boolean(data.data?.[s.hash]));
        } else if (provider === 'Premiumize') {
          cached = (await call('cache/check', { items: missing.map((s) => s.hash) })).response;
        } else if (provider === 'EasyDebrid') {
          cached = (await call('link/lookup', { urls: missing.map((s) => `magnet:?xt=urn:btih:${s.hash}`) })).cached;
        } else if (provider === 'OffCloud') {
          const data = await call('cache', { hashes: missing.map((s) => s.hash) });
          if (!Array.isArray(data.cachedItems)) throw failure('Unexpected cache response');
          cached = missing.map((s) => data.cachedItems.includes(s.hash));
        } else {
          const list = await call('torrents?limit=5000');
          if (!Array.isArray(list)) throw failure('Unexpected torrent list');
          const readyHashes = new Set(list.filter((item) => item.status === 'downloaded').map((item) => String(item.hash).toLowerCase()));
          cached = missing.map((s) => readyHashes.has(s.hash.toLowerCase()));
        }
        if (!Array.isArray(cached) || cached.length !== missing.length || cached.some((value) => typeof value !== 'boolean')) throw failure('Unexpected cache response');
        missing.forEach((source, index) => availability?.put(provider, token, source.hash, cached[index]));
        let missingIndex = 0;
        const combined = known.map((value) => value === undefined ? cached[missingIndex++] : value);
        sources.forEach((source, index) => {
          if (combined[index] === true) (available[source.hash] ||= []).push(provider);
          else if (provider === 'Real-Debrid') on_demand[source.hash] = ['Real-Debrid'];
        });
        statuses[provider] = provider === 'Real-Debrid' ? 'on_demand' : 'checked';
      } catch (error) {
        statuses[provider] = error.credentialRejected ? 'credential_rejected' : 'unavailable';
        if (!signal?.aborted) availability?.failed(provider, token, statuses[provider]);
      }
    }));
    return { available, on_demand, provider_status: statuses };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function resolveSingle(settings, input, { request = providerRequest, signal, sleep = waitForProvider } = {}) {
  if (!input || !/^[a-f0-9]{40}$/i.test(input.hash || '') || !['movie', 'series'].includes(input.type)) throw failure('Invalid movie source', 400);
  if (input.type === 'series' && (!Number.isInteger(input.season_int) || input.season_int < 0 || input.season_int > 1000 || !Number.isInteger(input.episode_int) || input.episode_int < 1 || input.episode_int > 10000)) throw failure('Invalid episode', 400);
  const provider = input.provider;
  if (!SUPPORTED_PROVIDERS.includes(provider)) throw failure(provider && provider !== 'none' ? `${provider} playback adapter is not available yet` : 'Choose a playback provider');
  const account = settings.provider_accounts?.[provider] || (settings.provider === provider ? { enabled: true, token: settings.debrid_token } : null);
  if (!account?.enabled || !account.token) throw failure(`Enable and configure ${provider} in Media Settings`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 20000);
  const call = (path, form) => request(provider, account.token, path, form, controller.signal);
  const key = crypto.createHash('sha256').update(`${provider}\n${account.token}\n${input.hash.toLowerCase()}\n${input.season_int || 0}\n${input.episode_int || 0}\n${input.stream_id || ''}\n${input.file_name || ''}`).digest('hex');
  for (const [hash, entry] of transfers) if (entry.expires < Date.now()) transfers.delete(hash);
  const remember = (id) => {
    if (request !== providerRequest) return;
    if (transfers.size >= 500) transfers.delete(transfers.keys().next().value);
    transfers.set(key, { id, expires: Date.now() + 15 * 60 * 1000 });
  };
  try {
    const magnet = `magnet:?xt=urn:btih:${input.hash.toLowerCase()}`;
    let download;
    if (provider === 'Premiumize') {
      const data = await call('transfer/directdl', { src: magnet });
      if (data.status !== 'success') throw failure('Premiumize has no ready stream for this source');
      download = chooseVideo(Array.isArray(data.content) ? data.content : [], input).link;
    } else if (provider === 'Torbox') {
      let id = request === providerRequest ? transfers.get(key)?.id : null;
      if (id == null) {
        const added = await call('torrents/createtorrent', { magnet, add_only_if_cached: 'true', allow_zip: 'false' });
        id = added.data?.torrent_id;
        if (!Number.isInteger(id) || id < 0) throw failure('Torbox is still preparing this source. Try another source or retry later.');
        remember(id);
      }
      let info;
      for (let attempt = 0; attempt < 4; attempt++) {
        const list = await call(`torrents/mylist?id=${id}&bypass_cache=true`);
        info = Array.isArray(list.data) ? list.data.find((value) => value.id === id) : list.data;
        if (info?.download_present && info?.download_finished) break;
        if (controller.signal.aborted) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!info?.download_present || !info?.download_finished) throw failure('This source is not ready on Torbox. Try another source or retry later.');
      const file = chooseVideo((info.files || []).map((value) => ({ ...value, path: value.name || value.short_name })), input);
      download = (await call(`torrents/requestdl?torrent_id=${id}&file_id=${file.id}&redirect=false`)).data;
    } else if (provider === 'EasyDebrid') {
      const data = await call('link/generate', { url: magnet });
      download = chooseVideo((data.files || []).map((file) => ({ ...file, path: file.filename })), input).url;
    } else if (provider === 'OffCloud') {
      const data = await call('cloud', { url: magnet });
      if (!/^[a-z0-9-]+$/i.test(data.requestId || '')) throw failure('OffCloud could not prepare this source', 502);
      const status = await call('cloud/status', { requestId: data.requestId });
      if (status.status !== 'downloaded' && status.status?.status !== 'downloaded') throw failure('This source is not ready on OffCloud. Retry shortly.');
      const files = await call(`cloud/explore/${data.requestId}`);
      if (!Array.isArray(files)) throw failure('OffCloud did not return video files');
      download = chooseVideo(files.map((url) => ({ path: decodeURIComponent(new URL(url).pathname), url })), input).url;
    } else {
      const list = await call('torrents?limit=5000');
      if (!Array.isArray(list)) throw failure('Real-Debrid returned an invalid account torrent list', 502);
      const matching = list.filter((item) => String(item.hash).toLowerCase() === input.hash.toLowerCase() && !RD_FAILED.has(item.status));
      let id = (request === providerRequest ? transfers.get(key)?.id : null) ||
        matching.find((item) => item.status === 'downloaded')?.id || matching[0]?.id;
      if (!id && input.allow_uncached_rd === true) {
        id = (await call('torrents/addMagnet', { magnet })).id;
        if (!/^[a-z0-9]+$/i.test(id || '')) throw failure('Real-Debrid could not add this source', 502);
        remember(id);
      }
      if (!/^[a-z0-9]+$/i.test(id || '')) throw failure('Real-Debrid has no ready account torrent for this source. Select a source to prepare it.');
      let info, file, selectionSent = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (controller.signal.aborted) throw failure('Real-Debrid preparation timed out. Retry this source shortly.');
        info = await call(`torrents/info/${id}`);
        if (RD_FAILED.has(info.status)) throw failure('Real-Debrid could not download this source. Choose another source.');
        if (info.status === 'waiting_files_selection' && Array.isArray(info.files) && info.files.length) {
          if (input.allow_uncached_rd !== true) throw failure('Real-Debrid requires manual source selection before downloading.');
          file = chooseVideo(info.files, input);
          if (!Number.isInteger(file.id) || file.id < 1) throw failure('Real-Debrid returned an invalid video file', 502);
          if (!selectionSent) {
            await call(`torrents/selectFiles/${id}`, { files: String(file.id) });
            selectionSent = true;
          }
        } else if (info.status === 'downloaded') {
          file = chooseVideo((info.files || []).filter((value) => value.selected), input);
          break;
        } else if (Array.isArray(info.files) && info.files.some((value) => value.selected)) {
          // Never replace another episode's selection in an existing account transfer.
          file = chooseVideo(info.files.filter((value) => value.selected), input);
        }
        if (attempt < 7) await sleep(750, controller.signal);
      }
      if (info?.status !== 'downloaded' || !file) {
        const progress = Math.max(0, Math.min(100, Math.floor(Number(info?.progress) || 0)));
        throw failure(`Real-Debrid is ${info?.status === 'downloading' ? `downloading this source (${progress}%)` : 'preparing this source'}. Retry this source shortly.`);
      }
      const index = (info.files || []).filter((value) => value.selected).findIndex((value) => value.id === file.id);
      const link = info.links?.[index];
      if (!link) throw failure('Real-Debrid did not return a matching file');
      download = (await call('unrestrict/link', { link })).download;
    }
    let url;
    try { url = new URL(download); } catch { throw failure('Provider did not return a playable URL', 502); }
    if (url.protocol !== 'https:' || url.username || url.password) throw failure('Provider returned an unsupported playback URL', 502);
    if (account.token.length >= 8 && (url.href.includes(account.token) || decodeURIComponent(url.href).includes(account.token))) {
      return { protectedPlaybackUrl: url.href, provider };
    }
    return { playbackUrl: url.href, provider };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function resolveMovieSource(settings, input, options = {}) {
  if (!input || !/^[a-f0-9]{40}$/i.test(input.hash || '') || !['movie', 'series'].includes(input.type)) throw failure('Invalid movie source', 400);
  if (input.type === 'series' && (!Number.isInteger(input.season_int) || input.season_int < 0 || !Number.isInteger(input.episode_int) || input.episode_int < 1)) throw failure('Invalid episode', 400);
  const configured = configuredProviders(settings);
  if (!configured.length) throw failure('Enable and configure a playback provider in Media Settings');
  const choice = input.provider || settings.default_provider || 'auto';
  const automatic = ['auto', 'none'].includes(choice);
  const scheduler = options.scheduler || (options.request ? createProviderScheduler({ randomInt: (limit) => limit - 1 }) : providerScheduler);
  const availability = options.availabilityCache || (options.request ? null : providerAvailability);
  if (!['auto', 'none'].includes(choice) && !configured.includes(choice)) throw failure('Selected provider is not enabled and configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const { available, on_demand, provider_status } = await lookupProviders(settings, [{ hash: input.hash.toLowerCase() }], { ...options, signal: controller.signal });
    const ready = available[input.hash.toLowerCase()] || [];
    const candidates = configured.filter((provider) => ready.includes(provider));
    const providers = automatic ? scheduler.order(candidates, settings) : candidates.filter((provider) => provider === choice);
    // Unknown RD remains a last resort and never competes with ready copies.
    if (input.allow_uncached_rd === true && on_demand[input.hash.toLowerCase()]?.includes('Real-Debrid') &&
      (automatic || choice === 'Real-Debrid') && !providers.includes('Real-Debrid')) providers.push('Real-Debrid');
    if (!providers.length) {
      if (choice === 'Real-Debrid' && provider_status['Real-Debrid'] === 'credential_rejected') throw failure('Real-Debrid rejected access. Check its token and account status in Media Settings.', 502);
      throw failure('No enabled provider has a ready copy of this source. Choose another source.');
    }
    const failures = [];
    for (const provider of providers) {
      if (controller.signal.aborted) break;
      scheduler.reserve(provider, settings);
      try {
        const result = await resolveSingle(settings, { ...input, provider }, { ...options, signal: controller.signal });
        scheduler.succeeded(provider, settings);
        availability?.put(provider, settings.provider_accounts[provider].token, input.hash, true);
        return result;
      }
      catch (error) {
        if (error.status === 400) throw error;
        scheduler.failed(provider, settings, error);
        availability?.invalidate(provider, settings.provider_accounts[provider].token, input.hash);
        // Only messages created by our adapter are safe to expose, never raw network errors.
        const reason = error.publicMessage || 'Provider request failed or timed out';
        if (providers.length === 1) throw failure(`${provider}: ${reason}`, error.status || 502);
        failures.push(`${provider}: ${reason}`);
      }
    }
    throw failure(failures.length ? failures.join(' | ') : 'Provider preparation timed out. Choose another source.', 502);
  } finally { clearTimeout(timer); }
}
module.exports = { SUPPORTED_PROVIDERS, chooseVideo, resolveMovieSource, lookupProviders, configuredProviders };
