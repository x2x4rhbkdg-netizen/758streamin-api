const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { createRequire } = require('node:module');
const { createPlaybackLogging } = require('../utils/playbackLogging.cjs');
const { createAdultTokens } = require('../utils/adultAccess.cjs');
const { addonVersion } = require('../utils/adultAddons.cjs');

async function fixture(t) {
  const logs = [];
  const logging = createPlaybackLogging({ secret: 'logging-test-only', logger: {
    log: (_tag, value) => logs.push(JSON.parse(value)),
  } });
  const filename = require.resolve('./adult.routes.cjs'), realRequire = createRequire(filename);
  const context = vm.createContext({ module: { exports: {} }, URL, Buffer, process: { env: { JWT_SECRET: 'fixture-only-secret' } },
    require: id => {
      if (id === '../middleware/authJwt.cjs') return { authJwt: (_req, _res, next) => next() };
      if (id === '../utils/movieSettings.cjs') return { readMovieSettings: async () => ({}) };
      return realRequire(id);
    } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const state = { authorized: true, enabled: true, pin: 'pin-SECRET', providerFailure: false, ticketFailure: false,
    providerWait: null, providerEntered: false };
  const addon = { id: 'fixture', enabled: true, scopes: ['adult'], manifest_url: 'https://addon.example/SECRET/manifest.json' };
  const settings = { adult_enabled: true, stremio_addons: [addon] };
  const tokens = createAdultTokens('fixture-only-secret');
  const item = { addon_id: addon.id, addon_version: addonVersion(addon), id: 'PRIVATE-ID', type: 'movie', title: 'PRIVATE-TITLE' };
  const source = { url: 'https://media.example/PRIVATE-PATH?token=SECRET', request_headers: { Cookie: 'SECRET-COOKIE' } };
  const router = context.module.exports.createAdultRouter({ logging,
    auth: (req, res, next) => { if (!state.authorized) return res.status(401).json({ error: 'unauthorized' }); req.device = { device_id: 7, platform: 'android_tv' }; next(); },
    readSettings: async () => ({ ...settings, adult_enabled: state.enabled }),
    readPin: async () => state.pin ? { pin: '1234', fingerprint: state.pin } : null,
    tokens: () => tokens,
    tickets: () => {
      if (state.ticketFailure) throw new Error('SECRET-COOKIE in provider error');
      return realRequire('../utils/moviePlaybackTickets.cjs').createPlaybackTickets('fixture-only-secret');
    },
    resolve: async () => {
      state.providerEntered = true;
      if (state.providerWait) await state.providerWait;
      if (state.providerFailure) throw Object.assign(new Error('SECRET-COOKIE in provider error'), { status: 502 });
      return { protectedPlaybackUrl: source.url, provider: 'Fixture' };
    },
    history: { owner: async () => 'PRIVATE-OWNER', list: async () => [] },
  });
  const app = express(); app.use(express.json());
  // Match the upstream playback router and the route-level middleware observing one request.
  app.use('/v1', logging.middleware); app.use('/v1', router);
  app.get('/v1/movies/stream/:ticket', (req, res) => {
    logging.identify({ type: 'adult' }, {}, req.params.ticket); res.end('fixture only');
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const unlock = tokens.issue('unlock', 7, { fingerprint: state.pin, age_confirmed: true });
  async function request(options = {}) {
    const grant = tokens.issue('source', 7, { fingerprint: state.pin, age_confirmed: true, item: options.item || item, source: options.source || source });
    const response = await fetch(`${base}/v1/adult/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlock_token: unlock, source_token: grant, pin: '1234', url: 'https://ATTACKER.example', ...options.body }) });
    return { status: response.status, body: await response.json(), grant };
  }
  return { logs, logging, state, source, item, request, base, unlock };
}

test('Adult resolve safely records one start/result/outcome and links to the protected media request', async t => {
  const f = await fixture(t), result = await f.request();
  assert.equal(result.status, 200);
  const events = f.logs.filter(log => log.route === '/adult/resolve');
  assert.deepEqual(events.map(log => log.event), ['adult_resolve_started', 'adult_resolve_result', 'request_complete']);
  assert.equal(new Set(events.map(log => log.request_id)).size, 1);
  const issued = events[1], outcome = events[2];
  assert.equal(issued.source_kind, 'direct'); assert.equal(issued.protected_link_issued, true);
  assert.equal(issued.playback_route, '/v1/movies/stream/:ticket');
  assert.equal(outcome.stage, 'resolved'); assert.equal(outcome.status, 200); assert.equal(outcome.media_type, 'adult');
  const url = new URL(result.body.playbackUrl);
  const media = await fetch(f.base + url.pathname); await media.text();
  const streamed = f.logs.find(log => log.route === '/movies/stream/:ticket');
  assert.equal(streamed.session_ref, issued.session_ref);
  const encoded = JSON.stringify(f.logs);
  for (const secret of ['SECRET', 'PRIVATE', '1234', f.unlock, result.grant, result.body.playbackUrl, url.pathname.split('/').pop()]) {
    assert.ok(!encoded.includes(secret), `Unexpected secret in logs: ${secret.slice(0, 12)}`);
  }
  assert.match(issued.source_ref, /^[a-f0-9]{24}$/);
});

test('provider resolution success logs a protected handoff without provider identifiers or source URLs', async t => {
  const f = await fixture(t), result = await f.request({ source: { hash: 'a'.repeat(40) } });
  assert.equal(result.status, 200);
  const issued = f.logs.find(log => log.event === 'adult_resolve_result');
  assert.equal(issued.source_kind, 'provider'); assert.equal(issued.protected_link_issued, true);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|PRIVATE|Fixture|media\.example/);
});

test('concurrent resolve is logged as busy without bypassing or releasing the first request reservation', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let release;
  f.state.providerWait = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = f.request({ source: { hash: 'a'.repeat(40) } });
  try {
    while (!f.state.providerEntered) await new Promise(resolve => setImmediate(resolve));
    const busy = await f.request();
    assert.equal(busy.status, 429);
    const denied = f.logs.find(log => log.event === 'request_complete');
    assert.equal(denied.stage, 'request_limits'); assert.equal(denied.status, 429);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await f.request()).status, 200);
});

for (const scenario of [
  ['auth', 401, 'authorization'], ['entitlement', 403, 'entitlement'], ['pin', 409, 'pin_configuration'],
  ['unlock', 403, 'unlock_validation'], ['source', 403, 'source_validation'], ['selection', 409, 'selection_validation'],
  ['provider', 502, 'provider_resolution'], ['ticket', 502, 'protected_link'],
]) {
  test(`Adult resolve ${scenario[0]} failure has safe stage/status without issuing a link`, async t => {
    const f = await fixture(t), [name, status, stage] = scenario;
    const options = {};
    if (name === 'auth') f.state.authorized = false;
    if (name === 'entitlement') f.state.enabled = false;
    if (name === 'pin') f.state.pin = null;
    if (name === 'unlock') options.body = { unlock_token: 'PRIVATE invalid token' };
    if (name === 'source') options.body = { source_token: 'PRIVATE invalid token' };
    if (name === 'selection') options.item = { ...f.item, addon_version: 'changed' };
    if (name === 'provider') { f.state.providerFailure = true; options.source = { hash: 'a'.repeat(40) }; }
    if (name === 'ticket') f.state.ticketFailure = true;
    const result = await f.request(options);
    assert.equal(result.status, status);
    const outcomes = f.logs.filter(log => log.event === 'request_complete');
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].status, status); assert.equal(outcomes[0].stage, stage);
    assert.equal(outcomes[0].outcome, 'failed');
    assert.equal(f.logs.some(log => log.protected_link_issued), false);
    assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|PRIVATE|1234|ATTACKER/);
  });
}
