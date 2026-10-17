const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseVideo, resolveMovieSource, lookupProviders } = require('./movieResolver.cjs');
const { createSourceCapabilities } = require('./movieSourceSessions.cjs');
const hash = 'a'.repeat(40);
const settings = (provider) => ({ default_provider: provider, provider_accounts: { [provider]: { enabled: true, token: 'private-key' } } });

test('PM TB and RD all receive availability checks and preserve their ready matches', async () => {
  const calls = [];
  const configuration = { provider_accounts: Object.fromEntries(['Premiumize', 'Torbox', 'Real-Debrid'].map((name) => [name, { enabled: true, token: 'test-key' }])) };
  const result = await lookupProviders(configuration, [{ hash }], { request: async (provider, _token, path) => {
    calls.push(provider);
    if (provider === 'Premiumize') return { response: [true] };
    if (provider === 'Torbox') {
      assert.match(path, /list_files=false/);
      return { data: { [hash.toUpperCase()]: { hash } } };
    }
    return [{ hash, status: 'downloaded' }];
  } });
  assert.deepEqual(new Set(calls), new Set(['Premiumize', 'Torbox', 'Real-Debrid']));
  assert.deepEqual(new Set(result.available[hash]), new Set(calls));
});

test('invalid TB response is a failed check, not a false zero-cached result', async () => {
  const result = await lookupProviders(settings('Torbox'), [{ hash }], { request: async () => ({ success: true, data: null }) });
  assert.equal(result.provider_status.Torbox, 'unavailable');
  assert.deepEqual(result.available, {});
});

test('provider throttling is distinguishable from network failure', async () => {
  const result = await lookupProviders(settings('Torbox'), [{ hash }], { request: async () => { throw Object.assign(new Error('hidden'), { rateLimited: true }); } });
  assert.equal(result.provider_status.Torbox, 'rate_limited');
});

test('Premiumize errors use documented safe codes, never raw credential-bearing messages', () => {
  const { premiumizeFailure } = require('./movieResolver.cjs');
  assert.match(premiumizeFailure({ code: 'account_limit_reached' }).message, /usage limit/);
  assert.equal(premiumizeFailure({ code: 'authentication_failed' }).credentialRejected, true);
  const unknown = premiumizeFailure({ code: 'https://secret.example', message: 'token=private-key' });
  assert.equal(unknown.message.includes('private-key'), false);
  assert.equal(unknown.message.includes('secret.example'), false);
});

test('cache checks retain lower resolutions beyond the first bounded batch', async () => {
  const sources = Array.from({ length: 225 }, (_, index) => ({ hash: (index + 1).toString(16).padStart(40, '0') }));
  const batches = [];
  const result = await lookupProviders(settings('Premiumize'), sources, { request: async (_provider, _token, path, form) => {
    assert.equal(path, 'cache/check');
    assert.ok(form.items.length <= 100);
    batches.push(form.items);
    return { response: form.items.map(() => true) };
  } });
  assert.equal(batches.length, 3);
  assert.equal(Object.keys(result.available).length, 225);
  assert.deepEqual(result.available[sources[224].hash], ['Premiumize']);
});

test('RD search is read-only and reports uncached availability as unverified, with one account-list request', async () => {
  const sources = Array.from({ length: 225 }, (_, index) => ({ hash: (index + 1).toString(16).padStart(40, '0') }));
  const calls = [];
  const result = await lookupProviders(settings('Real-Debrid'), sources, { request: async (_provider, _token, path, form) => {
    calls.push(path); assert.equal(path, 'torrents?limit=5000'); assert.equal(form, undefined); return [];
  } });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(result.available).length, 0);
  assert.equal(Object.keys(result.on_demand).length, 225);
  assert.deepEqual(result.on_demand[sources[224].hash], ['Real-Debrid']);
});

test('a manual RD selection adds only its magnet and selects only the requested episode', async () => {
  const calls = [];
  let selected = false;
  const result = await resolveMovieSource(settings('Real-Debrid'), { hash, type: 'series', season_int: 1, episode_int: 2, allow_uncached_rd: true }, {
    sleep: async () => {}, request: async (_provider, _token, path, form) => {
      calls.push(path);
      if (path === 'torrents?limit=5000') return [];
      if (path === 'torrents/addMagnet') { assert.equal(form.magnet, `magnet:?xt=urn:btih:${hash}`); return { id: 'NEW123' }; }
      if (path === 'torrents/info/NEW123') return { status: selected ? 'downloaded' : 'waiting_files_selection',
        files: [{ id: 1, path: '/Show.S01E01.mkv', bytes: 200, selected: 0 }, { id: 2, path: '/Show.S01E02.mkv', bytes: 100, selected: selected ? 1 : 0 }],
        links: selected ? ['https://host.example/episode2'] : [] };
      if (path === 'torrents/selectFiles/NEW123') { assert.equal(form.files, '2'); selected = true; return {}; }
      assert.equal(path, 'unrestrict/link'); assert.equal(form.link, 'https://host.example/episode2');
      return { download: 'https://cdn.example/episode2.mkv' };
    },
  });
  assert.equal(result.playbackUrl, 'https://cdn.example/episode2.mkv');
  assert.equal(calls.filter(path => path === 'torrents/addMagnet').length, 1);
  assert.equal(calls.filter(path => path.startsWith('torrents/selectFiles')).length, 1);
});

test('RD autoplay/background preparation cannot add a missing torrent without manual opt-in', async () => {
  await assert.rejects(resolveMovieSource(settings('Real-Debrid'), { hash, type: 'movie' }, { request: async (_provider, _token, path) => {
    assert.equal(path, 'torrents?limit=5000'); return [];
  } }), { status: 409 });
});

test('manual automatic failover tries known-ready providers before unverified RD', async () => {
  const config = { provider_accounts: { 'Real-Debrid': { enabled: true, token: 'rd' }, Premiumize: { enabled: true, token: 'pm' } } };
  const result = await resolveMovieSource(config, { hash, type: 'movie', provider: 'auto', allow_uncached_rd: true }, { request: async (provider, _token, path) => {
    if (provider === 'Real-Debrid') { assert.equal(path, 'torrents?limit=5000'); return []; }
    if (path === 'cache/check') return { response: [true] };
    return { status: 'success', content: [{ path: 'Movie.mp4', link: 'https://cdn.example/movie.mp4' }] };
  } });
  assert.equal(result.provider, 'Premiumize');
});

test('RD preparing/downloading/failed sources never generate playback links or repeatedly select files', async () => {
  for (const status of ['downloading', 'magnet_conversion', 'waiting_files_selection', 'virus', 'dead', 'error']) {
    let selections = 0;
    await assert.rejects(resolveMovieSource(settings('Real-Debrid'), { hash, type: 'movie', allow_uncached_rd: true }, {
      sleep: async () => {}, request: async (_provider, _token, path) => {
        if (path === 'torrents?limit=5000') return [];
        if (path === 'torrents/addMagnet') return { id: 'PENDING' };
        if (path === 'torrents/info/PENDING') return { status, progress: 27, files: [{ id: 1, path: 'Movie.mp4' }] };
        assert.equal(path, 'torrents/selectFiles/PENDING'); selections++; return {};
      },
    }), error => { assert.equal(error.status, 409); assert.match(error.message, status === 'downloading' ? /27%/ : /preparing|could not download/); return true; });
    assert.ok(selections <= 1);
  }
});

test('RD no-match episodes and invalid new torrent IDs never select or unrestrict files', async () => {
  for (const invalidId of [false, true]) {
    await assert.rejects(resolveMovieSource(settings('Real-Debrid'), { hash, type: 'series', season_int: 1, episode_int: 2, allow_uncached_rd: true }, {
      sleep: async () => {}, request: async (_provider, _token, path) => {
        if (path === 'torrents?limit=5000') return [];
        if (path === 'torrents/addMagnet') return { id: invalidId ? '../unsafe' : 'SAFE' };
        assert.equal(path, 'torrents/info/SAFE');
        return { status: 'waiting_files_selection', files: [{ id: 1, path: 'Show.S01E01.mkv' }] };
      },
    }));
  }
});
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

test('balanced playback falls back to TB when PM fails preparing a source cached on both', async () => {
  const prepared = [];
  const config = { default_provider: 'auto', provider_accounts: {
    Premiumize: { enabled: true, token: 'pm-test-key' }, Torbox: { enabled: true, token: 'tb-test-key' },
  } };
  const result = await resolveMovieSource(config, { hash, type: 'movie', provider: 'auto' }, { request: cachedRequest(async (provider, _token, path) => {
    if (provider === 'Premiumize') { prepared.push(provider); return { status: 'error', code: 'link_generation_failed', message: 'secret upstream message' }; }
    if (path === 'torrents/createtorrent') { prepared.push(provider); return { data: { torrent_id: 12 } }; }
    if (path.startsWith('torrents/mylist')) return { data: [{ id: 12, download_present: true, download_finished: true, files: [{ id: 4, name: 'Movie.mkv' }] }] };
    return { data: 'https://cdn.example/tb-video.mkv' };
  }) });
  assert.deepEqual(prepared, ['Premiumize', 'Torbox']);
  assert.equal(result.provider, 'Torbox');
  assert.equal(result.playbackUrl, 'https://cdn.example/tb-video.mkv');
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
test('provider failover reports adapter reasons but never raw upstream credentials', async () => {
  const configuration = { provider_accounts: { Premiumize: { enabled: true, token: 'secret-pm' }, EasyDebrid: { enabled: true, token: 'secret-ed' } } };
  await assert.rejects(resolveMovieSource(configuration, { hash, type: 'movie', provider: 'auto' }, { request: cachedRequest(async (provider) => {
    if (provider === 'Premiumize') return { status: 'success', content: [{ path: 'Readme.txt' }] };
    throw new Error('https://upstream.example/?token=secret-ed');
  }) }), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /Premiumize: No matching video file/);
    assert.match(error.message, /EasyDebrid: Provider request failed or timed out/);
    assert.equal(error.message.includes('secret-ed'), false);
    assert.equal(error.message.includes('upstream.example'), false);
    return true;
  });
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
  assert.equal(second.requireDiscoveredSource(1, input).allow_uncached_rd, false);
  assert.equal(second.requireDiscoveredSource(1, { ...input, allow_uncached_rd: true }).allow_uncached_rd, true);
  assert.equal(second.requireDiscoveredSource(1, { ...input, allow_uncached_rd: 'true' }).allow_uncached_rd, false);
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

test('production RD adapter handles 201/204, reports pending downloads, and reuses the transfer on retry', async () => {
  const originalFetch = global.fetch;
  let additions = 0, selections = 0, unrestricts = 0, selected = false, completed = false;
  global.fetch = async (url, options) => {
    assert.equal(url.origin, 'https://api.real-debrid.com');
    assert.equal(options.headers.Authorization, 'Bearer private-key');
    const form = new URLSearchParams(options.body);
    let data;
    if (url.pathname.endsWith('/torrents')) data = [];
    else if (url.pathname.endsWith('/addMagnet')) {
      assert.equal(form.get('magnet'), `magnet:?xt=urn:btih:${hash}`); additions++;
      return new Response(JSON.stringify({ id: 'HTTP123' }), { status: 201 });
    } else if (url.pathname.endsWith('/selectFiles/HTTP123')) {
      assert.equal(form.get('files'), '7'); selected = true; selections++;
      return new Response(null, { status: 204 });
    } else if (url.pathname.endsWith('/info/HTTP123')) data = {
      status: !selected ? 'waiting_files_selection' : completed ? 'downloaded' : 'downloading', progress: 35,
      files: [{ id: 7, path: 'Movie.mp4', bytes: 100, selected: selected ? 1 : 0 }], links: completed ? ['https://host.example/video'] : [],
    };
    else { assert.ok(url.pathname.endsWith('/unrestrict/link')); unrestricts++; data = { download: 'https://cdn.example/Movie.mp4' }; }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const input = { hash, provider: 'Real-Debrid', type: 'movie', allow_uncached_rd: true };
  try {
    await assert.rejects(resolveMovieSource(settings('Real-Debrid'), input, { sleep: async () => {} }), /downloading this source \(35%\)/);
    assert.equal(unrestricts, 0);
    completed = true;
    const result = await resolveMovieSource(settings('Real-Debrid'), input, { sleep: async () => {} });
    assert.equal(result.playbackUrl, 'https://cdn.example/Movie.mp4');
    assert.equal(additions, 1); assert.equal(selections, 1); assert.equal(unrestricts, 1);
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  } finally { global.fetch = originalFetch; }
});

test('RD rejected credentials are reported without claiming on-demand availability', async () => {
  const result = await lookupProviders(settings('Real-Debrid'), [{ hash }], { request: async () => {
    throw Object.assign(new Error('private-key'), { credentialRejected: true });
  } });
  assert.equal(result.provider_status['Real-Debrid'], 'credential_rejected');
  assert.deepEqual(result.available, {}); assert.deepEqual(result.on_demand, {});
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});
