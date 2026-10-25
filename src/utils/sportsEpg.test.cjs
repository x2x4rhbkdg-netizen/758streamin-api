const test = require('node:test');
const assert = require('node:assert/strict');
const { epgMatchesEvent } = require('./sportsEpg.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const start = Date.UTC(2026, 9, 25, 17);
const event = { title: 'Houston Texans vs New York Giants', homeTeam: 'Houston Texans', awayTeam: 'New York Giants', startsAt: start };
const program = { title: 'Live: NFL Football', description: 'The Houston Texans host the New York Giants.', start_timestamp: start / 1000, stop_timestamp: start / 1000 + 10800 };
test('matches both full team names in plain or base64 title/description with an overlapping kickoff', () => {
  assert.equal(epgMatchesEvent(event, { epg_listings: [program] }), true);
  assert.equal(epgMatchesEvent({ title: event.title, startsAt: start }, [program]), true);
  assert.equal(epgMatchesEvent(event, [{ ...program, description: Buffer.from(program.description).toString('base64') }]), true);
});
test('does not guess from sport, one team, a wrong time, un-timed guide data, replay or malformed listings', () => {
  for (const row of [
    { ...program, description: 'NFL Football' }, { ...program, description: 'Houston Texans vs Dallas Cowboys' },
    { ...program, start_timestamp: start / 1000 - 86400, stop_timestamp: start / 1000 - 80000 },
    { ...program, start_timestamp: null }, { ...program, title: 'NFL highlights' },
    { ...program, description: 'A replay: Houston Texans host the New York Giants' }, null,
  ]) assert.equal(epgMatchesEvent(event, [row]), false);
  assert.equal(epgMatchesEvent(event, { epg_listings: {} }), false);
  assert.equal(epgMatchesEvent({ startsAt: start, title: 'NFL Football' }, [program]), false);
});
test('EPG transport uses server credentials only, bounded request fields, no redirects and decodes listings', async () => {
  const fetch = async (url, init) => {
    assert.equal(url.searchParams.get('stream_id'), '123');
    assert.equal(url.searchParams.get('limit'), '24');
    assert.equal(url.searchParams.get('action'), 'get_short_epg');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response(JSON.stringify({ epg_listings: [program] }));
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./sportsEpg.cjs'), 'utf8'), {
    module, Buffer, AbortController, URL, fetch, setTimeout, clearTimeout,
    require: name => name === '../config/env.cjs' ? { env: { XUI_HTTP_FALLBACK: false } } : require(name),
  });
  const rows = await module.exports.fetchSportsEpg({ upstream_base_url: 'https://example.com', username: 'user', password: 'secret' }, '123');
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [program]);
});
