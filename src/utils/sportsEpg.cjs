function words(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function decode(value) {
  const text = String(value || '').slice(0, 20000).trim();
  if (!text || text.length % 4 || !/^[A-Za-z0-9+/=]+$/.test(text)) return text;
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  return decoded && !/[\x00-\x08\x0e-\x1f\ufffd]/.test(decoded) ? decoded : text;
}
function timestamp(value) {
  if (value == null || value === '') return NaN;
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value) * (Number(value) > 1e12 ? 1 : 1000);
  return Date.parse(String(value).replace(' ', 'T'));
}
function listings(payload) {
  return (Array.isArray(payload) ? payload : payload?.epg_listings || payload?.listings || payload?.programs || []);
}
function epgMatchesEvent(event, payload) {
  const teams = [event.homeTeam, event.awayTeam].every(Boolean)
    ? [event.homeTeam, event.awayTeam] : String(event.title || '').split(/\s+(?:vs\.?|v|versus)\s+/i);
  const names = teams.map(words);
  if (names.length !== 2 || names.some(name => name.length < 4) || names[0] === names[1] || !Number.isFinite(event.startsAt)) return false;
  const programs = listings(payload);
  return Array.isArray(programs) && programs.slice(0, 24).some(program => {
    if (!program || typeof program !== 'object') return false;
    const start = timestamp(program.start_timestamp || program.start_ms || program.start || program.start_time);
    const end = timestamp(program.stop_timestamp || program.end_timestamp || program.end_ms || program.end || program.stop || program.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start > event.startsAt + 1800000 ||
        end <= event.startsAt || Math.abs(start - event.startsAt) > 7200000) return false;
    const text = words([program.title, program.program_title, program.name, program.description, program.desc, program.plot].map(decode).join(' '));
    if (/\b(?:replay|highlights|classic)\b/.test(text)) return false;
    return names.every(name => ` ${text} `.includes(` ${name} `));
  });
}

async function fetchSportsEpg(upstream, streamId) {
  const { buildXuiPlayerApiUrls } = require('./xui.cjs');
  const { env } = require('../config/env.cjs');
  const urls = buildXuiPlayerApiUrls(upstream, { allowHttpFallback: env.XUI_HTTP_FALLBACK });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1800);
  try {
    for (const candidate of urls.slice(0, 2)) {
      try {
        const url = new URL(candidate);
        url.searchParams.set('action', 'get_short_epg'); url.searchParams.set('stream_id', streamId); url.searchParams.set('limit', '24');
        const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { 'User-Agent': 'streamin-api/1.0' } });
        if (!response.ok || Number(response.headers.get('content-length')) > 262144) { await response.body?.cancel(); continue; }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 262144) { controller.abort(); return []; }
          chunks.push(Buffer.from(chunk));
        }
        const rows = listings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return Array.isArray(rows) ? rows.slice(0, 24) : [];
      } catch { if (controller.signal.aborted) return []; }
    }
    return [];
  } finally { clearTimeout(timer); }
}
module.exports = { epgMatchesEvent, fetchSportsEpg };
