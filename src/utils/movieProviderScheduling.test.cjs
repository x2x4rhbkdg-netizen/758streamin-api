const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderScheduler, createAvailabilityCache } = require('./movieProviderScheduling.cjs');
const { lookupProviders, resolveMovieSource } = require('./movieResolver.cjs');
const hash = 'a'.repeat(40), other = 'b'.repeat(40);
const settings = { default_provider: 'auto', provider_accounts: {
  Premiumize: { enabled: true, token: 'pm-key' }, EasyDebrid: { enabled: true, token: 'ed-key' },
} };
const stable = () => createProviderScheduler({ randomInt: (limit) => limit - 1 });
const request = async (provider, _token, path, form) => {
  if (path === 'cache/check') return { response: form.items.map(() => true) };
  if (path === 'link/lookup') return { cached: form.urls.map(() => true) };
  return provider === 'Premiumize' ? { status: 'success', content: [{ path: 'Movie.mp4', link: 'https://cdn.example/pm.mp4' }] } :
    { files: [{ filename: 'Movie.mp4', url: 'https://cdn.example/ed.mp4' }] };
};

test('automatic playback distributes starts evenly instead of using fixed priority', async () => {
  const scheduler = stable(), providers = [];
  for (let index = 0; index < 10; index++) providers.push((await resolveMovieSource(settings, { hash, type: 'movie', provider: 'auto' }, { request, scheduler })).provider);
  assert.deepEqual(providers, Array.from({ length: 10 }, (_, i) => i % 2 ? 'EasyDebrid' : 'Premiumize'));
});
test('concurrent reservations distribute before provider requests finish', async () => {
  const scheduler = stable();
  const results = await Promise.all(Array.from({ length: 10 }, () => resolveMovieSource(settings, { hash, type: 'movie' }, { request, scheduler })));
  assert.equal(results.filter((r) => r.provider === 'Premiumize').length, 5);
});
test('explicit provider selection is honored, and only ready providers are balanced', async () => {
  const scheduler = stable();
  for (let i = 0; i < 3; i++) assert.equal((await resolveMovieSource(settings, { hash, type: 'movie', provider: 'Premiumize' }, { request, scheduler })).provider, 'Premiumize');
  const result = await resolveMovieSource(settings, { hash, type: 'movie' }, { scheduler, request: async (p, t, path, form) => path === 'link/lookup' ? { cached: [false] } : request(p, t, path, form) });
  assert.equal(result.provider, 'Premiumize');
});
test('failed providers fall back and cool down without making a ready provider mandatory', async () => {
  let now = 1000;
  const scheduler = createProviderScheduler({ now: () => now, randomInt: (limit) => limit - 1 });
  const bad = async (p, t, path, form) => {
    if (p === 'Premiumize' && path !== 'cache/check') throw new Error('private-network-error');
    return request(p, t, path, form);
  };
  assert.equal((await resolveMovieSource(settings, { hash, type: 'movie' }, { scheduler, request: bad })).provider, 'EasyDebrid');
  assert.equal(scheduler.order(['Premiumize', 'EasyDebrid'], settings)[0], 'EasyDebrid');
  assert.deepEqual(scheduler.order(['Premiumize'], settings), ['Premiumize']);
  now += 31000;
  scheduler.reserve('EasyDebrid', settings);
  assert.equal(scheduler.order(['Premiumize', 'EasyDebrid'], settings)[0], 'Premiumize');
});
test('account rotation does not inherit another token usage and counters expire', () => {
  let now = 1000;
  const scheduler = createProviderScheduler({ now: () => now, randomInt: (limit) => limit - 1 });
  scheduler.reserve('Premiumize', settings);
  assert.equal(scheduler.order(['Premiumize', 'EasyDebrid'], settings)[0], 'EasyDebrid');
  const rotated = { ...settings, provider_accounts: { ...settings.provider_accounts, Premiumize: { enabled: true, token: 'new-key' } } };
  assert.equal(scheduler.order(['Premiumize', 'EasyDebrid'], rotated)[0], 'Premiumize');
  now += 3600001;
  assert.equal(scheduler.order(['Premiumize', 'EasyDebrid'], settings)[0], 'Premiumize');
});
test('hash cache reuses search checks on playback and checks only missing hashes', async () => {
  const availabilityCache = createAvailabilityCache(), calls = [];
  const tracked = async (p, t, path, form) => { calls.push({ p, path, form }); return request(p, t, path, form); };
  await lookupProviders(settings, [{ hash }, { hash: other }], { request: tracked, availabilityCache });
  assert.equal(calls.length, 2);
  await resolveMovieSource(settings, { hash, type: 'movie' }, { request: tracked, availabilityCache, scheduler: stable() });
  assert.equal(calls.filter((c) => c.path === 'cache/check' || c.path === 'link/lookup').length, 2);
  const third = 'c'.repeat(40);
  await lookupProviders(settings, [{ hash }, { hash: third }], { request: tracked, availabilityCache });
  assert.deepEqual(calls.at(-2).form.items, [third]);
  assert.equal(calls.at(-1).form.urls.length, 1);
});
test('availability cache expiry, negative caching and token isolation are independent', () => {
  let now = 1000;
  const cache = createAvailabilityCache({ now: () => now });
  cache.put('Premiumize', 'pm-key', hash, true); cache.put('Premiumize', 'pm-key', other, false);
  assert.equal(cache.get('Premiumize', 'different-key', hash), undefined);
  assert.equal(cache.get('Premiumize', 'pm-key', other), false);
  now += 15001;
  assert.equal(cache.get('Premiumize', 'pm-key', other), undefined);
  assert.equal(cache.get('Premiumize', 'pm-key', hash), true);
  now += 45000; assert.equal(cache.get('Premiumize', 'pm-key', hash), undefined);
});
test('unavailable credentials are briefly backed off without inventing ready links', async () => {
  const availabilityCache = createAvailabilityCache(); let calls = 0;
  const rejected = async () => { calls++; throw Object.assign(new Error('secret'), { credentialRejected: true }); };
  const config = { provider_accounts: { Premiumize: settings.provider_accounts.Premiumize } };
  const first = await lookupProviders(config, [{ hash }], { request: rejected, availabilityCache });
  const second = await lookupProviders(config, [{ hash: other }], { request: rejected, availabilityCache });
  assert.equal(calls, 1); assert.deepEqual(second.available, {});
  assert.equal(first.provider_status.Premiumize, 'credential_rejected');
  assert.equal(second.provider_status.Premiumize, 'credential_rejected');
});
test('unverified RD is never balanced ahead of ready copies and cannot add automatically', async () => {
  const config = { ...settings, provider_accounts: { ...settings.provider_accounts, 'Real-Debrid': { enabled: true, token: 'rd-key' } } };
  const scheduler = stable();
  const paths = [];
  const mocked = async (p, t, path, form) => { paths.push(path); return p === 'Real-Debrid' ? [] : request(p, t, path, form); };
  const result = await resolveMovieSource(config, { hash, type: 'movie', allow_uncached_rd: true }, { request: mocked, scheduler });
  assert.equal(result.provider, 'Premiumize');
  assert.equal(paths.includes('torrents/addMagnet'), false);
});
