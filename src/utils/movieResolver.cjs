const crypto = require('node:crypto');
const SUPPORTED_PROVIDERS = ['Real-Debrid', 'Premiumize', 'Torbox', 'EasyDebrid', 'OffCloud'];
const transfers = new Map();
function failure(message, status = 409) { return Object.assign(new Error(message), { status }); }

function chooseVideo(files, input) {
  const videos = files.filter((file) => /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(file.path || '') && !/\bsample\b/i.test(file.path));
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
  if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? `${provider} rejected its credential. Update Movie Settings.` : `${provider} could not resolve this source`, 502);
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

async function lookupProviders(settings, sources, { request = providerRequest, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 8000);
  const available = {}, statuses = {};
  try {
    await Promise.all(configuredProviders(settings).map(async (provider) => {
      const token = settings.provider_accounts[provider].token;
      const call = (path, form) => request(provider, token, path, form, controller.signal);
      try {
        let cached;
        if (provider === 'Torbox') {
          const data = await call(`torrents/checkcached?hash=${sources.map((s) => s.hash).join(',')}&format=object&list_files=true`);
          cached = sources.map((s) => Boolean(data.data?.[s.hash]));
        } else if (provider === 'Premiumize') {
          cached = (await call('cache/check', { items: sources.map((s) => s.hash) })).response;
        } else if (provider === 'EasyDebrid') {
          cached = (await call('link/lookup', { urls: sources.map((s) => `magnet:?xt=urn:btih:${s.hash}`) })).cached;
        } else if (provider === 'OffCloud') {
          const data = await call('cache', { hashes: sources.map((s) => s.hash) });
          if (!Array.isArray(data.cachedItems)) throw failure('Unexpected cache response');
          cached = sources.map((s) => data.cachedItems.includes(s.hash));
        } else {
          const list = await call('torrents?limit=5000');
          if (!Array.isArray(list)) throw failure('Unexpected torrent list');
          cached = sources.map((s) => list.some((item) => String(item.hash).toLowerCase() === s.hash && item.status === 'downloaded'));
        }
        if (!Array.isArray(cached) || cached.length !== sources.length) throw failure('Unexpected cache response');
        sources.forEach((source, index) => {
          if (cached[index] === true) (available[source.hash] ||= []).push(provider);
        });
        statuses[provider] = provider === 'Real-Debrid' ? 'ready_account_torrents' : 'checked';
      } catch { statuses[provider] = 'unavailable'; }
    }));
    return { available, provider_status: statuses };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function resolveSingle(settings, input, { request = providerRequest, signal } = {}) {
  if (!input || !/^[a-f0-9]{40}$/i.test(input.hash || '') || !['movie', 'series'].includes(input.type)) throw failure('Invalid movie source', 400);
  if (input.type === 'series' && (!Number.isInteger(input.season_int) || input.season_int < 0 || input.season_int > 1000 || !Number.isInteger(input.episode_int) || input.episode_int < 1 || input.episode_int > 10000)) throw failure('Invalid episode', 400);
  const provider = input.provider;
  if (!SUPPORTED_PROVIDERS.includes(provider)) throw failure(provider && provider !== 'none' ? `${provider} playback adapter is not available yet` : 'Choose a playback provider');
  const account = settings.provider_accounts?.[provider] || (settings.provider === provider ? { enabled: true, token: settings.debrid_token } : null);
  if (!account?.enabled || !account.token) throw failure(`Enable and configure ${provider} in Movie Settings`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 20000);
  const call = (path, form) => request(provider, account.token, path, form, controller.signal);
  const key = crypto.createHash('sha256').update(`${provider}\n${account.token}\n${input.hash.toLowerCase()}\n${input.season_int || 0}\n${input.episode_int || 0}`).digest('hex');
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
      const id = Array.isArray(list) ? list.find((item) => String(item.hash).toLowerCase() === input.hash.toLowerCase() && item.status === 'downloaded')?.id : null;
      if (!/^[a-z0-9]+$/i.test(id || '')) throw failure('Real-Debrid has no ready account torrent for this source. Choose another provider.');
      let info = await call(`torrents/info/${id}`);
      if (!Array.isArray(info.files) || !info.files.length) throw failure('Real-Debrid is still preparing file information. Retry later.');
      const file = chooseVideo(info.files.filter((value) => value.selected), input);
      if (info.status !== 'downloaded') throw failure('This source is not ready on Real-Debrid. Choose another source or retry later.');
      const index = (info.files || []).filter((value) => value.selected).findIndex((value) => value.id === file.id);
      const link = info.links?.[index];
      if (!link) throw failure('Real-Debrid did not return a matching file');
      download = (await call('unrestrict/link', { link })).download;
    }
    let url;
    try { url = new URL(download); } catch { throw failure('Provider did not return a playable URL', 502); }
    if (url.protocol !== 'https:' || url.username || url.password) throw failure('Provider returned an unsupported playback URL', 502);
    if (account.token.length >= 8 && url.href.includes(account.token)) throw failure('Provider returned an unsafe playback URL', 502);
    return { playbackUrl: url.href, provider };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function resolveMovieSource(settings, input, options = {}) {
  if (!input || !/^[a-f0-9]{40}$/i.test(input.hash || '') || !['movie', 'series'].includes(input.type)) throw failure('Invalid movie source', 400);
  if (input.type === 'series' && (!Number.isInteger(input.season_int) || input.season_int < 0 || !Number.isInteger(input.episode_int) || input.episode_int < 1)) throw failure('Invalid episode', 400);
  const configured = configuredProviders(settings);
  if (!configured.length) throw failure('Enable and configure a movie provider in Movie Settings');
  const choice = input.provider || settings.default_provider || 'auto';
  if (!['auto', 'none'].includes(choice) && !configured.includes(choice)) throw failure('Selected provider is not enabled and configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const { available } = await lookupProviders(settings, [{ hash: input.hash.toLowerCase() }], { ...options, signal: controller.signal });
    const ready = available[input.hash.toLowerCase()] || [];
    const providers = ['auto', 'none'].includes(choice) ? configured.filter((provider) => ready.includes(provider)) : ready.filter((provider) => provider === choice);
    if (!providers.length) throw failure('No enabled provider has a ready copy of this source. Choose another source.');
    for (const provider of providers) {
      if (controller.signal.aborted) break;
      try { return await resolveSingle(settings, { ...input, provider }, { ...options, signal: controller.signal }); }
      catch (error) { if (error.status === 400) throw error; if (providers.length === 1) throw error; }
    }
    throw failure('Ready providers could not prepare this source. Choose another source.', 502);
  } finally { clearTimeout(timer); }
}
module.exports = { SUPPORTED_PROVIDERS, chooseVideo, resolveMovieSource, lookupProviders, configuredProviders };
