const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseVideo, resolveMovieSource, lookupProviders } = require('./movieResolver.cjs');
const { createSourceCapabilities } = require('./movieSourceSessions.cjs');
const hash = 'a'.repeat(40);
const settings = (provider) => ({ default_provider: provider, provider_accounts: { [provider]: { enabled: true, token: 'private-key' } } });
function cachedRequest(run) {
  return async (provider, token, path, form, signal) => {
    if (path === 'cache/check') return { status: 'success', response: [true] };
    if (path.startsWith('torrents/checkcached')) return { success: true, data: { [hash]: { files: [] } } };
    if (path === 'link/lookup') return { cached: [true] };
    if (path === 'cache') return { cachedItems: [hash] };
    if (path === 'torrents?limit=5000') return [{ hash, id: 'ABC123', status: 'downloaded' }];
    return run(provider, token, path, form, signal);
  };
}
test('Premiumize resolves a cached movie and excludes samples', async () => {
  const result = await resolveMovieSource(settings('Premiumize'), { hash, type: 'movie' }, { request: cachedRequest(async (provider, token, path, form) => {
    assert.equal(provider, 'Premiumize'); assert.equal(token, 'private-key'); assert.equal(path, 'transfer/directdl');
    assert.equal(form.src, `magnet:?xt=urn:btih:${hash}`);
    return { status: 'success', content: [{ path: 'sample.mkv', size: 1000, link: 'https://cdn.example/sample' }, { path: 'movie.mkv', size: 200, link: 'https://cdn.example/movie.mkv' }] };
  }) });
  assert.equal(result.playbackUrl, 'https://cdn.example/movie.mkv');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});
test('Real-Debrid selects a ready account episode without starting a download', async () => {
  const calls = [];
  const result = await resolveMovieSource(settings('Real-Debrid'), { hash, type: 'series', season_int: 1, episode_int: 2 }, { request: cachedRequest(async (_provider, _token, path) => {
    calls.push(path);
    if (path === 'torrents/info/ABC123') return { status: 'downloaded', files: [{ id: 1, selected: 1, path: '/Show.S01E01.mkv', bytes: 100 },
      { id: 2, selected: 1, path: '/Show.S01E02.mkv', bytes: 200 }], links: ['https://host.example/episode1', 'https://host.example/episode2'] };
    assert.equal(path, 'unrestrict/link'); return { download: 'https://cdn.example/episode2.mkv' };
  }) });
  assert.equal(result.playbackUrl, 'https://cdn.example/episode2.mkv');
  assert.deepEqual(calls, ['torrents/info/ABC123', 'unrestrict/link']);
});
test('Torbox adds only cached torrents and returns a signed CDN link, never its key', async () => {
  const result = await resolveMovieSource(settings('Torbox'), { hash, type: 'movie' }, { request: cachedRequest(async (_provider, _token, path, form) => {
    if (path === 'torrents/createtorrent') { assert.equal(form.add_only_if_cached, 'true'); return { data: { torrent_id: 12 } }; }
    if (path.startsWith('torrents/mylist')) return { data: [{ id: 12, download_finished: true, download_present: true, files: [{ id: 4, name: 'Movie.mp4', size: 50 }] }] };
    assert.equal(path, 'torrents/requestdl?torrent_id=12&file_id=4&redirect=false'); return { data: 'https://cdn.example/movie.mp4' };
  }) });
  assert.equal(result.playbackUrl, 'https://cdn.example/movie.mp4');
});
test('EasyDebrid selects only the requested video from generated files', async () => {
  const result = await resolveMovieSource(settings('EasyDebrid'), { hash, type: 'movie' }, { request: cachedRequest(async (_provider, _token, path) => {
    assert.equal(path, 'link/generate'); return { files: [{ filename: 'Poster.jpg', size: 50, url: 'https://cdn.example/poster' },
      { filename: 'Movie.mp4', size: 100, url: 'https://cdn.example/movie.mp4' }] };
  }) });
  assert.equal(result.provider, 'EasyDebrid');
});
test('credential-bearing links are server-only until wrapped with a playback ticket', async () => {
  const result = await resolveMovieSource(settings('Premiumize'), { hash, type: 'movie' }, { request: cachedRequest(async () => ({
    status: 'success', content: [{ path: 'Movie.mp4', link: 'https://cdn.example/movie.mp4?token=private-key' }],
  })) });
  assert.equal(result.playbackUrl, undefined);
  assert.equal(result.protectedPlaybackUrl, 'https://cdn.example/movie.mp4?token=private-key');
});
test('OffCloud resolves a ready cached cloud file without returning its key', async () => {
  const result = await resolveMovieSource(settings('OffCloud'), { hash, type: 'movie' }, { request: cachedRequest(async (_provider, _token, path) => {
    if (path === 'cloud') return { requestId: 'ABC' };
    if (path === 'cloud/status') return { status: 'downloaded' };
    assert.equal(path, 'cloud/explore/ABC'); return ['https://cdn.example/Movie.mp4'];
  }) });
  assert.equal(result.playbackUrl, 'https://cdn.example/Movie.mp4');
});
test('enabled providers are queried concurrently and a failed account does not discard ready sources', async () => {
  let started = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const configuration = { provider_accounts: { Premiumize: { enabled: true, token: 'pm' }, EasyDebrid: { enabled: true, token: 'ed' }, Torbox: { enabled: false, token: 'tb' } } };
  const result = await lookupProviders(configuration, [{ hash }], { request: async (provider) => {
    started++; if (started === 2) release(); await gate;
    if (provider === 'Premiumize') throw new Error('Credential failure: secret');
    return { cached: [true] };
  } });
  assert.equal(started, 2);
  assert.deepEqual(result.available[hash], ['EasyDebrid']);
  assert.equal(result.provider_status.Premiumize, 'unavailable');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('automatic provider selection falls back after a ready provider fails', async () => {
  const configuration = { provider_accounts: { Premiumize: { enabled: true, token: 'pm' }, EasyDebrid: { enabled: true, token: 'ed' } } };
  const result = await resolveMovieSource(configuration, { hash, type: 'movie', provider: 'auto' }, { request: cachedRequest(async (provider) => {
    if (provider === 'Premiumize') throw new Error('Temporary failure');
    return { files: [{ filename: 'Movie.mp4', url: 'https://cdn.example/movie.mp4' }] };
  }) });
  assert.equal(result.provider, 'EasyDebrid');
});
test('invalid/disabled/uncached sources cannot start transfer requests', async () => {
  let calls = 0;
  await assert.rejects(resolveMovieSource(settings('Premiumize'), { hash: 'bad', type: 'movie' }, { request: async () => { calls++; } }));
  await assert.rejects(resolveMovieSource({ provider_accounts: {} }, { hash, type: 'movie' }, { request: async () => { calls++; } }));
  assert.equal(calls, 0);
  await assert.rejects(resolveMovieSource(settings('Premiumize'), { hash, type: 'movie' }, { request: async (_provider, _token, path) => {
    assert.equal(path, 'cache/check'); return { response: [false] };
  } }), { status: 409 });
  assert.throws(() => chooseVideo([{ path: 'Show.S01E01.mkv' }], { type: 'series', season_int: 1, episode_int: 2 }));
});
test('non-HTTPS links and embedded user/password credentials are rejected', async () => {
  for (const link of ['file:///tmp/private.mp4', 'https://private-key:password@cdn.example/movie.mp4']) {
    await assert.rejects(resolveMovieSource(settings('Premiumize'), { hash, type: 'movie' }, { request: cachedRequest(async () => ({ status: 'success', content: [{ path: 'Movie.mp4', link }] })) }), { status: 502 });
  }
});
test('source capability is device/episode bound, tamper protected, and portable between workers', () => {
  const first = createSourceCapabilities('fixture-signing-key');
  const second = createSourceCapabilities('fixture-signing-key');
  const token = first.issueSource(1, hash, { type: 'series', season_int: 2, episode_int: 3 });
  const input = { source_token: token, hash, type: 'series', season_int: 2, episode_int: 3, provider: 'auto' };
  assert.equal(second.requireDiscoveredSource(1, input).hash, hash);
  assert.throws(() => second.requireDiscoveredSource(2, input), { status: 409 });
  assert.throws(() => second.requireDiscoveredSource(1, { ...input, episode_int: 4 }), { status: 409 });
  assert.throws(() => second.requireDiscoveredSource(1, { ...input, source_token: token + 'bad' }), { status: 409 });
});

test('production Torbox HTTP adapter builds the cache/create/link requests without returning its API key', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(url.pathname);
    assert.equal(url.origin, 'https://api.torbox.app');
    assert.equal(options.redirect, 'error');
    let data;
    if (url.pathname.endsWith('/checkcached')) data = { [hash]: { files: [{ name: 'Movie.mp4' }] } };
    else if (url.pathname.endsWith('/createtorrent')) {
      assert.equal(options.body.get('add_only_if_cached'), 'true');
      assert.equal(options.body.get('magnet'), `magnet:?xt=urn:btih:${hash}`);
      data = { torrent_id: 22 };
    } else if (url.pathname.endsWith('/mylist')) data = [{ id: 22, download_present: true, download_finished: true, files: [{ id: 1, name: 'Movie.mp4' }] }];
    else { assert.equal(url.searchParams.get('token'), 'private-key'); data = 'https://cdn.example/Movie.mp4'; }
    return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await resolveMovieSource(settings('Torbox'), { hash, provider: 'Torbox', type: 'movie' });
    assert.equal(result.playbackUrl, 'https://cdn.example/Movie.mp4');
    assert.equal(calls.length, 4);
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  } finally { global.fetch = originalFetch; }
});
