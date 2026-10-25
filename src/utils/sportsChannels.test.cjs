const test = require('node:test');
const assert = require('node:assert/strict');
const { channelName, normalizeSportsAliases, matchSportsChannels, createSportsChannelResolver } = require('./sportsChannels.cjs');
const categories = [{ category_id: '1', category_name: 'Sports' }, { category_id: '2', category_name: 'Adult' }, { category_id: '3', category_name: 'Radio' }];
const stream = (id, name, other = {}) => ({ stream_id: id, category_id: '1', name, ...other });
test('format normalization preserves channel numbers and distinct brands', () => {
  assert.equal(channelName('UK: TNT Sports1 FHD'), channelName('TNT Sports 1'));
  assert.equal(channelName('ESPN+ HD'), channelName('ESPN Plus'));
  assert.notEqual(channelName('ESPN'), channelName('ESPN 2'));
  assert.notEqual(channelName('BT Sport 1'), channelName('TNT Sports 1'));
});
test('only exact names or explicit aliases match; output excludes upstream secrets and adult/radio content', () => {
  const result = matchSportsChannels(['TNT Sports 1', 'ESPN'], [
    stream(1, 'UK: TNT Sports1 HD', { direct_url: 'secret', password: 'secret' }),
    stream(2, 'BT Sport 1'), stream(3, 'ESPN 2'), stream(4, 'ESPN', { category_id: '2' }),
    stream(5, 'ESPN', { category_id: '3' }), stream(6, 'ESPN', { is_adult: 'true' }),
    stream(7, 'ESPN', { is_adult: 1 }), stream(8, 'ESPN', { stream_type: 'movie' }),
    stream(9, 'ESPN', { category_id: 'unknown' }), stream(1, 'TNT Sports 1'),
  ], categories, [{ broadcaster: 'TNT Sports 1', channels: ['BT Sport 1'] }]);
  assert.deepEqual(result.map(row => row.stream_id), ['1', '2']);
  assert.equal(result[1].match_type, 'alias');
  assert.deepEqual(Object.keys(result[0]).sort(), ['broadcaster', 'category_id', 'match_type', 'name', 'stream_id']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('aliases validate bounds, canonical duplicates and fields', () => {
  assert.deepEqual(normalizeSportsAliases([{ broadcaster: ' ESPN ', channels: [' ESPN HD ', ' ESPN HD '] }]), [{ broadcaster: 'ESPN', channels: ['ESPN HD'] }]);
  for (const input of [null, Array(201).fill({}), [{ broadcaster: 'ESPN', channels: [] }], [{ broadcaster: 'ESPN', channels: ['bad\nname'] }],
    [{ broadcaster: 'ESPN', channels: ['ESPN'], url: 'untrusted' }], [{ broadcaster: 'ESPN', channels: ['ESPN'] }, { broadcaster: 'ESPN HD', channels: ['ESPN'] }]]) {
    assert.throws(() => normalizeSportsAliases(input), { status: 400 });
  }
});
function fixture() {
  let time = 0, password = 'one', enabled = true, aliases = [];
  const calls = [];
  const resolve = createSportsChannelResolver({
    now: () => time,
    readSettings: async () => ({ sports_enabled: true, live_tv_enabled: enabled, sports_broadcaster_aliases: aliases }),
    loadEvents: async () => ({ events: [{ id: 'event', broadcasters: ['TNT Sports 1'] }, { id: 'empty', broadcasters: [] }] }),
    getUpstream: async device => ({ upstream_base_url: 'https://example.com', username: String(device), password }),
    loadCatalog: async upstream => { calls.push(upstream.username); return { categories, streams: [stream(1, 'TNT Sports 1'), stream(2, 'BT Sport 1')] }; },
  });
  return { resolve, calls, advance: () => { time += 120001; }, password: value => { password = value; }, disable: () => { enabled = false; }, aliases: value => { aliases = value; } };
}
test('cache is singleflight, expires and isolates devices and changed credentials; aliases are fresh', async () => {
  const f = fixture();
  await Promise.all([f.resolve('a', 'event'), f.resolve('a', 'event')]);
  assert.deepEqual(f.calls, ['a']);
  f.aliases([{ broadcaster: 'TNT Sports 1', channels: ['BT Sport 1'] }]);
  assert.equal((await f.resolve('a', 'event')).channels.length, 2);
  assert.equal(f.calls.length, 1);
  await f.resolve('b', 'event'); assert.deepEqual(f.calls, ['a', 'b']);
  f.password('two'); await f.resolve('a', 'event'); assert.equal(f.calls.length, 3);
  f.advance(); await f.resolve('a', 'event'); assert.equal(f.calls.length, 4);
});
test('no broadcaster or teams yields no channel; missing event and disabled access never fetch another catalog', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolve('a', 'empty'), { event_id: 'empty', channels: [] });
  await assert.rejects(f.resolve('a', 'missing'), { status: 404 });
  f.disable(); await assert.rejects(f.resolve('a', 'event'), { status: 403 });
  assert.equal(f.calls.length, 1);
});
test('falls back to both team names in EPG descriptions, isolated by subscription and with failures tolerated', async () => {
  let calls = 0;
  const start = Date.UTC(2026, 9, 25, 17);
  const resolve = createSportsChannelResolver({ now: () => start,
    readSettings: async () => ({ sports_enabled: true }), getUpstream: async device => ({ username: device }),
    loadEvents: async () => ({ events: [{ id: 'nfl', title: 'Houston Texans vs New York Giants', homeTeam: 'Houston Texans', awayTeam: 'New York Giants', startsAt: start, broadcasters: [] }] }),
    loadCatalog: async () => ({ categories, streams: [stream(1, 'TSN 1 HD'), stream(2, 'ESPN'), stream(3, 'Adult sports', { category_id: '2' })] }),
    loadEpg: async (account, id) => { calls++;
      if (id !== '1') throw new Error('private upstream error');
      return account.username === 'a' ? [{ title: 'Live NFL Football', description: Buffer.from('The Houston Texans host the New York Giants in NFL week 7.').toString('base64'), start_timestamp: start / 1000, stop_timestamp: start / 1000 + 10800 }] : [];
    },
  });
  assert.deepEqual((await resolve('a', 'nfl')).channels, [{ stream_id: '1', category_id: '1', name: 'TSN 1 HD', broadcaster: 'Program guide match', match_type: 'epg' }]);
  assert.equal(calls, 2);
  await resolve('a', 'nfl'); assert.equal(calls, 2);
  assert.deepEqual((await resolve('b', 'nfl')).channels, []); assert.equal(calls, 4);
});
test('exact TSN broadcaster matches avoid scanning EPG and never confuse channel numbers', async () => {
  let scans = 0;
  const resolve = createSportsChannelResolver({ readSettings: async () => ({ sports_enabled: true }), getUpstream: async () => ({}),
    loadEvents: async () => ({ events: [{ id: 'nfl', title: 'Houston Texans vs New York Giants', broadcasters: ['TSN 1'] }] }),
    loadCatalog: async () => ({ categories, streams: [stream(1, 'TSN 1 HD'), stream(2, 'TSN 2 HD')] }),
    loadEpg: async () => { scans++; return []; },
  });
  assert.deepEqual((await resolve('a', 'nfl')).channels.map(row => row.stream_id), ['1']);
  assert.equal(scans, 0);
});
test('EPG scan is bounded and skips adult/radio streams even inside the candidate selection', async () => {
  let active = 0, peak = 0, calls = 0;
  const resolve = createSportsChannelResolver({ readSettings: async () => ({ sports_enabled: true }), getUpstream: async () => ({}),
    loadEvents: async () => ({ events: [{ id: 'event', title: 'Houston Texans vs New York Giants', startsAt: Date.now(), broadcasters: [] }] }),
    loadCatalog: async () => ({ categories, streams: [stream(1001, 'TSN adult', { is_adult: 1 }), stream(1002, 'TSN radio', { category_id: '3' }),
      ...Array.from({ length: 100 }, (_, i) => stream(i + 1, `Sports ${i}`))] }),
    loadEpg: async (_upstream, id) => { assert.ok(Number(id) < 1000); calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve)); active--; return [];
    },
  });
  assert.deepEqual((await resolve('a', 'event')).channels, []);
  assert.equal(calls, 60); assert.equal(peak, 4);
});
test('search result outside the default list resolves by ID against the full eligible feed', async () => {
  const { normalizeSportsFeed, upcomingSports } = require('./sportsEvents.cjs');
  const now = Date.now();
  const feed = normalizeSportsFeed({ version: 1, updatedAt: now, events: Array.from({ length: 151 }, (_, i) => ({
    id: String(i).padStart(3, '0'), title: `Team ${i} vs Opponent`, sport: 'Soccer', startsAt: now + 3600000, status: 'scheduled', broadcasters: [{ name: 'TSN 1' }],
  })) });
  assert.equal(upcomingSports(feed, now).events.some(row => row.id === '150'), false);
  const resolve = createSportsChannelResolver({ readSettings: async () => ({ sports_enabled: true }), getUpstream: async () => ({}),
    loadEvents: async options => upcomingSports(feed, now, options),
    loadCatalog: async () => ({ categories, streams: [stream(1, 'TSN 1 HD')] }),
  });
  assert.deepEqual((await resolve('a', '150')).channels.map(row => row.stream_id), ['1']);
});
test('missing subscriptions and failed upstream requests do not return stale channels', async () => {
  const base = { readSettings: async () => ({ sports_enabled: true }), loadEvents: async () => ({ events: [{ id: 'event', broadcasters: ['ESPN'] }] }) };
  await assert.rejects(createSportsChannelResolver({ ...base, getUpstream: async () => null })(1, 'event'), { status: 404 });
  let time = 0, failed = false;
  const resolve = createSportsChannelResolver({ ...base, now: () => time, getUpstream: async () => ({}), loadCatalog: async () => {
    if (failed) throw new Error('provider error'); return { categories, streams: [stream(1, 'ESPN')] };
  } });
  assert.equal((await resolve(1, 'event')).channels.length, 1);
  failed = true; time = 120001;
  await assert.rejects(resolve(1, 'event'), /provider error/);
});
test('disabling Sports blocks channel lookup before loading events, subscription or EPG', async () => {
  const unexpected = async () => { throw new Error('must not load'); };
  const resolve = createSportsChannelResolver({ readSettings: async () => ({ sports_enabled: false, live_tv_enabled: true }),
    loadEvents: unexpected, getUpstream: unexpected, loadCatalog: unexpected, loadEpg: unexpected });
  await assert.rejects(resolve(1, 'event'), { status: 403, message: 'Sports is disabled for this device' });
  const legacy = createSportsChannelResolver({ readSettings: async () => ({}), loadEvents: unexpected });
  await assert.rejects(legacy(1, 'event'), { status: 403 });
});
