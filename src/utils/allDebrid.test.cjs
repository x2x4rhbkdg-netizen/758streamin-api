const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupProviders, resolveMovieSource } = require('./movieResolver.cjs');
const { allDebridFailure } = require('./allDebrid.cjs');
const hash = 'd'.repeat(40);
const settings = token => ({ default_provider: 'AllDebrid', provider_accounts: { AllDebrid: { enabled: true, token } } });
const success = magnets => ({ status: 'success', data: { magnets } });

test('AD search stays read-only, checks one account list and never invents cached availability', async () => {
  const calls = [];
  const sources = Array.from({ length: 225 }, (_, index) => ({ hash: index.toString(16).padStart(40, '0') }));
  const result = await lookupProviders(settings('search-only'), sources, { request: async (provider, token, path) => {
    assert.equal(provider, 'AllDebrid'); calls.push(path); return success([]);
  } });
  assert.deepEqual(calls, ['../v4.1/magnet/status']);
  assert.deepEqual(result.available, {});
  assert.deepEqual(result.on_demand[sources[224].hash], ['AllDebrid']);
  assert.equal(result.provider_status.AllDebrid, 'on_demand');
});

test('AD cannot upload an unverified source during autoplay', async () => {
  const calls = [];
  await assert.rejects(resolveMovieSource(settings('no-auto-upload'), { hash, type: 'movie' }, { request: async (_provider, _token, path) => {
    calls.push(path); return success([]);
  } }), /ready copy/);
  assert.deepEqual(calls, ['../v4.1/magnet/status']);
});

test('manual AD preparation uploads only the selected hash and unlocks the matching nested episode', async () => {
  const calls = [];
  const config = settings('manual-episode-key');
  const request = async (_provider, _token, path, form) => {
    calls.push({ path, form });
    if (path === 'magnet/upload') {
      assert.deepEqual(form.magnets, [`magnet:?xt=urn:btih:${hash}`]);
      return success([{ id: 501, hash }]);
    }
    if (path === '../v4.1/magnet/status') return form.id ? success([{ id: 501, statusCode: 4, files: [
      { n: 'Season 1', e: [{ n: 'Show.S01E01.mkv', s: 200, l: 'https://alldebrid.com/f/one' }, { n: 'Show.S01E02.mkv', s: 100, l: 'https://alldebrid.com/f/two' }] },
    ] }]) : success([]);
    assert.equal(path, 'link/unlock'); assert.equal(form.link, 'https://alldebrid.com/f/two');
    return { status: 'success', data: { link: 'https://cdn.example/episode2.mkv' } };
  };
  const result = await resolveMovieSource(config, { hash, type: 'series', season_int: 1, episode_int: 2, allow_uncached_ad: true }, { request });
  assert.equal(result.provider, 'AllDebrid');
  assert.equal(result.playbackUrl, 'https://cdn.example/episode2.mkv');
  assert.equal(JSON.stringify(result).includes(config.provider_accounts.AllDebrid.token), false);
  assert.equal(calls.filter(call => call.path === 'magnet/upload').length, 1);
  const readiness = await lookupProviders(config, [{ hash }], { request: async () => success([{ id: 501, statusCode: 4 }]) });
  assert.deepEqual(readiness.available[hash], ['AllDebrid']);
});

test('preparing AD transfers retry without uploading again, and unsafe errors are redacted', async () => {
  const config = settings('ad-still-downloading');
  let uploads = 0;
  const request = async (_provider, _token, path, form) => {
    if (path === 'magnet/upload') { uploads++; return success([{ id: 502, hash }]); }
    return success(form.id ? [{ id: 502, statusCode: 1 }] : []);
  };
  const input = { hash, type: 'movie', allow_uncached_ad: true };
  for (let index = 0; index < 2; index++) await assert.rejects(resolveMovieSource(config, input, { request, sleep: async () => {} }), /preparing this source/);
  assert.equal(uploads, 1);
  assert.equal(allDebridFailure({ error: { code: 'AUTH_BLOCKED', message: 'secret-token' } }).credentialRejected, true);
  assert.equal(allDebridFailure({ error: { code: 'UNKNOWN', message: 'secret-token' } }).message.includes('secret-token'), false);
});

test('production AD transport uses Bearer auth, v4.1 status and URL-encoded selected magnets', async () => {
  const original = global.fetch;
  const config = settings('ad-http-test-secret');
  const calls = [];
  global.fetch = async (url, options) => {
    assert.equal(url.origin, 'https://api.alldebrid.com');
    assert.equal(options.headers.Authorization, 'Bearer ad-http-test-secret');
    assert.equal(String(url).includes('ad-http-test-secret'), false);
    const form = new URLSearchParams(options.body || '');
    calls.push(url.pathname);
    let data;
    if (url.pathname === '/v4/magnet/upload') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(form.getAll('magnets[]'), [`magnet:?xt=urn:btih:${hash}`]);
      data = success([{ id: 503, hash }]);
    } else if (url.pathname === '/v4.1/magnet/status') data = success(form.get('id') ? [{ id: 503, statusCode: 4, files: [{ n: 'Example.mp4', s: 100, l: 'https://alldebrid.com/f/movie' }] }] : []);
    else { assert.equal(url.pathname, '/v4/link/unlock'); data = { status: 'success', data: { link: 'https://cdn.example/movie.mp4' } }; }
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    assert.equal((await resolveMovieSource(config, { hash, type: 'movie', allow_uncached_ad: true })).provider, 'AllDebrid');
    assert.deepEqual(calls, ['/v4.1/magnet/status', '/v4/magnet/upload', '/v4.1/magnet/status', '/v4/link/unlock']);
  } finally { global.fetch = original; }
});
