const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSportsFeed, upcomingSports, createSportsEvents } = require('./sportsEvents.cjs');
const now = Date.UTC(2026, 9, 25, 15), HOUR = 3600000;
const event = { id: '1', title: 'Home vs Away', sport: 'Football', league: 'League', status: 'scheduled', startsAt: now + HOUR,
  homeBadge: 'https://example.com/home.png', awayBadge: 'javascript:bad', broadcasters: [{ name: 'Sports TV' }, { name: 'Sports TV' }] };
const feed = events => ({ version: 1, updatedAt: now, events, partial: true, attribution: 'Fixture source' });
test('normalizes bounded display metadata without exposing playback links or unsafe image schemes', () => {
  const result = normalizeSportsFeed(feed([event, event, null, { ...event, id: '', startsAt: -1 }]));
  assert.equal(result.events.length, 1); assert.equal(result.partial, true);
  assert.equal(result.events[0].awayBadge, undefined); assert.deepEqual(result.events[0].broadcasters, ['Sports TV']);
  assert.equal(result.events[0].homeBadge, event.homeBadge);
  assert.throws(() => normalizeSportsFeed({ version: 2, events: [] }), { status: 503 });
});
test('live and upcoming schedule excludes completed, cancelled, postponed and stale events and sorts stably', () => {
  const data = normalizeSportsFeed(feed([event, { ...event, id: 'live', status: 'live', startsAt: now - HOUR },
    { ...event, id: 'old-live', status: 'live', startsAt: now - 9 * HOUR }, { ...event, id: 'old', startsAt: now - 5 * HOUR },
    { ...event, id: 'far', startsAt: now + 8 * 24 * HOUR },
    ...['finished', 'postponed', 'cancelled'].map(status => ({ ...event, id: status, status }))]));
  assert.deepEqual(upcomingSports(data, now).events.map(value => value.id), ['live', '1']);
  assert.throws(() => upcomingSports({ ...data, updatedAt: now - 25 * HOUR }, now), { status: 503 });
});
test('retains the 13th broadcaster and recently started scheduled NFL fixtures among busy soccer listings', () => {
  const nfl = { ...event, id: 'nfl', title: 'Houston Texans vs New York Giants', sport: 'American Football', league: 'NFL',
    startsAt: now - 2 * HOUR, broadcasters: [...Array.from({ length: 12 }, (_, i) => ({ name: `Network ${i}` })), { name: 'TSN 1' }] };
  const data = normalizeSportsFeed(feed([
    ...Array.from({ length: 200 }, (_, i) => ({ ...event, id: `soccer-${i}`, sport: 'Soccer', startsAt: now - 3 * HOUR })), nfl,
  ]));
  const found = upcomingSports(data, now).events.find(row => row.id === 'nfl');
  assert.ok(found); assert.equal(found.status, 'scheduled');
  assert.ok(found.broadcasters.includes('TSN 1'));
  const future = upcomingSports(normalizeSportsFeed(feed([...data.events.map(row => ({ ...row, startsAt: now + HOUR }))])), now);
  assert.ok(future.events.some(row => row.id === 'nfl'));
});
test('keeps a full simultaneous NFL kickoff slate alongside other sports and upcoming fixtures', () => {
  const events = ['Soccer', 'Basketball', 'Ice Hockey', 'Volleyball', 'Handball', 'American Football'].flatMap(sport =>
    Array.from({ length: sport === 'American Football' ? 7 : 40 }, (_, i) => ({ ...event, sport, id: `${sport}-${i}`, startsAt: now - 2 * HOUR })));
  events.push(...Array.from({ length: 50 }, (_, i) => ({ ...event, id: `next-${i}` })));
  const result = upcomingSports(normalizeSportsFeed(feed(events)), now);
  assert.equal(result.events.length, 100);
  assert.equal(result.events.filter(row => row.sport === 'American Football').length, 7);
  assert.ok(result.events.filter(row => row.startsAt >= now).length >= 25);
});
test('coalesces downloads and caches for five minutes, with bounded stale fallback and backoff', async () => {
  let time = now, calls = 0, failed = false;
  const load = createSportsEvents({ now: () => time, fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error');
    if (failed) throw new Error('upstream failed');
    return new Response(JSON.stringify(feed([event])));
  } });
  const [first, second] = await Promise.all([load(), load()]);
  assert.deepEqual(first, second); assert.equal(calls, 1); assert.equal(first.stale, false);
  time += 299999; await load(); assert.equal(calls, 1);
  time++; failed = true; assert.equal((await load()).stale, true); assert.equal(calls, 2);
  await load(); assert.equal(calls, 2);
  time += HOUR; await assert.rejects(load(), { status: 503 });
});
test('many live events cannot crowd upcoming fixtures out of the Home panel', () => {
  const data = normalizeSportsFeed(feed([...Array.from({ length: 50 }, (_, index) => ({ ...event, id: `live-${index}`, status: 'live', startsAt: now - HOUR })), event]));
  const result = upcomingSports(data, now);
  assert.equal(result.events.filter(value => value.status === 'live').length, 25);
  assert.equal(result.events.at(-1).id, '1');
});
test('rejects redirects, failed HTTP, oversized and malformed feeds without caching them', async () => {
  for (const result of [new Response('', { status: 429 }), new Response('{'), new Response('{}'),
    new Response('{}', { headers: { 'content-length': '6000001' } })]) {
    let calls = 0;
    const load = createSportsEvents({ now: () => now, fetchImpl: async () => { calls++; return result; } });
    await assert.rejects(load(), { status: 503 }); await assert.rejects(load(), { status: 503 }); assert.equal(calls, 1);
  }
  const load = createSportsEvents({ url: 'http://example.com', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(load(), { status: 503 });
});
