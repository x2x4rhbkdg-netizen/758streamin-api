const DEFAULT_URL = 'https://auth.arvio.tv/.netlify/functions/sports-metadata';
const HOUR = 3600000;
const unavailable = () => Object.assign(new Error('Sports events temporarily unavailable'), { status: 503 });
const text = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, limit) : '';
const score = value => Number.isFinite(value) ? String(value).slice(0, 12) : text(value, 12);
function image(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048 ? url.href : undefined; } catch { return undefined; }
}
function normalizeSportsFeed(data) {
  if (data?.version !== 1 || !Array.isArray(data.events) || data.events.length > 10000 || !Number.isFinite(data.updatedAt)) throw unavailable();
  const seen = new Set();
  const events = data.events.flatMap(event => {
    const id = text(event?.id, 100), title = text(event?.title), sport = text(event?.sport, 80);
    if (!id || !title || !sport || !Number.isSafeInteger(event.startsAt) || event.startsAt <= 0 || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title, sport, startsAt: event.startsAt, league: text(event.league, 100), status: text(event.status, 40).toLowerCase(),
      homeTeam: text(event.homeTeam, 100), awayTeam: text(event.awayTeam, 100), homeBadge: image(event.homeBadge), awayBadge: image(event.awayBadge),
      homeScore: score(event.homeScore), awayScore: score(event.awayScore),
      broadcasters: [...new Set((Array.isArray(event.broadcasters) ? event.broadcasters : []).slice(0, 30).map(value => text(value?.name, 80)).filter(Boolean))].slice(0, 12) }];
  });
  return { events, updatedAt: data.updatedAt, partial: data.partial === true, attribution: text(data.attribution, 100) };
}
function upcomingSports(feed, now = Date.now()) {
  if (feed.updatedAt > now + HOUR || now - feed.updatedAt > 24 * HOUR) throw unavailable();
  const eligible = feed.events.filter(event => {
    if (['finished', 'postponed', 'cancelled', 'canceled'].includes(event.status)) return false;
    return event.status === 'live' ? event.startsAt >= now - 8 * HOUR && event.startsAt <= now + HOUR
      : event.startsAt >= now && event.startsAt <= now + 7 * 24 * HOUR;
  }).sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  const live = eligible.filter(event => event.status === 'live').slice(0, 25);
  return { ...feed, events: [...live, ...eligible.filter(event => event.status !== 'live').slice(0, 100 - live.length)] };
}
function createSportsEvents({ fetchImpl = globalThis.fetch, now = Date.now, url = process.env.SPORTS_EVENTS_URL || DEFAULT_URL } = {}) {
  let cache, fetchedAt = 0, pending, retryAt = 0;
  return async () => {
    const snapshot = stale => ({ ...upcomingSports(cache, now()), stale });
    const fallback = () => { if (cache && now() - fetchedAt < HOUR) return snapshot(true); throw unavailable(); };
    if (cache && now() - fetchedAt < 300000) return snapshot(false);
    if (now() < retryAt) return fallback();
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password) throw unavailable();
        const response = await fetchImpl(target.href, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok || Number(response.headers.get('content-length')) > 6000000) throw unavailable();
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 6000000) { controller.abort(); throw unavailable(); }
          chunks.push(Buffer.from(chunk));
        }
        const feed = normalizeSportsFeed(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        upcomingSports(feed, now());
        cache = feed; fetchedAt = now(); retryAt = 0;
        return snapshot(false);
      } catch { retryAt = now() + 60000; return fallback(); }
      finally { clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
module.exports = { normalizeSportsFeed, upcomingSports, createSportsEvents, getSportsEvents: createSportsEvents() };
