const crypto = require('node:crypto');
const SUPPORTED_PROVIDERS = ['Real-Debrid', 'Premiumize', 'Torbox'];
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
  const bases = { 'Real-Debrid': 'https://api.real-debrid.com/rest/1.0/', Premiumize: 'https://www.premiumize.me/api/', Torbox: 'https://api.torbox.app/v1/api/' };
  const url = new URL(path, bases[provider]);
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (form && provider === 'Torbox') {
    body = new FormData();
    for (const [key, value] of Object.entries(form)) body.set(key, value);
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  // TorBox requires its token on requestdl; resolve server-side rather than exposing the credential to the app.
  if (provider === 'Torbox' && url.pathname.endsWith('/requestdl')) url.searchParams.set('token', token);
  const response = await fetch(url, { method: form ? 'POST' : 'GET', signal, redirect: 'error', headers, body });
  if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? `${provider} rejected its credential. Update Movie Settings.` : `${provider} could not resolve this source`, 502);
  const data = response.status === 204 ? {} : await response.json();
  if (provider === 'Torbox' && data.success !== true) throw failure('Torbox could not prepare this source', 502);
  return data;
}

async function resolveMovieSource(settings, input, { request = providerRequest } = {}) {
  if (!input || !/^[a-f0-9]{40}$/i.test(input.hash || '') || !['movie', 'series'].includes(input.type)) throw failure('Invalid movie source', 400);
  if (input.type === 'series' && (!Number.isInteger(input.season_int) || input.season_int < 0 || input.season_int > 1000 || !Number.isInteger(input.episode_int) || input.episode_int < 1 || input.episode_int > 10000)) throw failure('Invalid episode', 400);
  const provider = input.provider || settings.default_provider;
  if (!SUPPORTED_PROVIDERS.includes(provider)) throw failure(provider && provider !== 'none' ? `${provider} playback adapter is not available yet` : 'Choose a playback provider');
  const account = settings.provider_accounts?.[provider] || (settings.provider === provider ? { enabled: true, token: settings.debrid_token } : null);
  if (!account?.enabled || !account.token) throw failure(`Enable and configure ${provider} in Movie Settings`);
  const controller = new AbortController();
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
        const added = await call('torrents/createtorrent', { magnet });
        id = added.data?.torrent_id;
        if (!Number.isInteger(id) || id < 0) throw failure('Torbox is still preparing this source. Try another source or retry later.');
        remember(id);
      }
      const list = await call(`torrents/mylist?id=${id}&bypass_cache=true`);
      const info = Array.isArray(list.data) ? list.data.find((value) => value.id === id) : list.data;
      if (!info?.download_present || !info?.download_finished) throw failure('This source is not ready on Torbox. Try another source or retry later.');
      const file = chooseVideo((info.files || []).map((value) => ({ ...value, path: value.name || value.short_name })), input);
      download = (await call(`torrents/requestdl?torrent_id=${id}&file_id=${file.id}&redirect=false`)).data;
    } else {
      let id = request === providerRequest ? transfers.get(key)?.id : null;
      if (!id) {
        id = (await call('torrents/addMagnet', { magnet })).id;
        if (!/^[a-z0-9]+$/i.test(id || '')) throw failure('Real-Debrid could not prepare this source', 502);
        remember(id);
      }
      let info = await call(`torrents/info/${id}`);
      if (!Array.isArray(info.files) || !info.files.length) throw failure('Real-Debrid is still preparing file information. Retry later.');
      const file = chooseVideo(info.files, input);
      if (info.status === 'waiting_files_selection') {
        await call(`torrents/selectFiles/${id}`, { files: String(file.id) });
        info = await call(`torrents/info/${id}`);
      }
      if (info.status !== 'downloaded') throw failure('This source is not ready on Real-Debrid. Choose another source or retry later.');
      const index = (info.files || []).filter((value) => value.selected).findIndex((value) => value.id === file.id);
      const link = info.links?.[index];
      if (!link) throw failure('Real-Debrid did not return a matching file');
      download = (await call('unrestrict/link', { link })).download;
    }
    let url;
    try { url = new URL(download); } catch { throw failure('Provider did not return a playable URL', 502); }
    if (url.protocol !== 'https:' || url.username || url.password) throw failure('Provider returned an unsupported playback URL', 502);
    return { playbackUrl: url.href, provider };
  } finally { clearTimeout(timer); }
}
module.exports = { SUPPORTED_PROVIDERS, chooseVideo, resolveMovieSource };
