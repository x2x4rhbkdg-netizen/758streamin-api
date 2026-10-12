const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseVideo, resolveMovieSource } = require('./movieResolver.cjs');
const hash = 'a'.repeat(40);
const settings = (provider) => ({ default_provider: provider, provider_accounts: { [provider]: { enabled: true, token: 'private' } } });

test('default provider resolves a playable movie and skips samples', async () => {
  const result = await resolveMovieSource(settings('Premiumize'), { hash, type: 'movie' }, { request: async (provider, token, path, form) => {
    assert.equal(provider, 'Premiumize'); assert.equal(token, 'private'); assert.equal(path, 'transfer/directdl');
    assert.equal(form.src, `magnet:?xt=urn:btih:${hash}`);
    return { status: 'success', content: [{ path: 'sample.mkv', size: 1000, link: 'https://cdn.example/sample' }, { path: 'movie.mkv', size: 200, link: 'https://cdn.example/movie.mkv' }] };
  } });
  assert.equal(result.playbackUrl, 'https://cdn.example/movie.mkv');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('Real-Debrid selects the requested episode and unrestricts its link', async () => {
  const calls = [];
  const files = [{ id: 1, path: '/Show.S01E01.mkv', bytes: 100 }, { id: 2, path: '/Show.S01E02.mkv', bytes: 200 }];
  let infoCount = 0;
  const result = await resolveMovieSource(settings('Real-Debrid'), { hash, type: 'series', season_int: 1, episode_int: 2 }, { request: async (_provider, _token, path, form) => {
    calls.push(path);
    if (path === 'torrents/addMagnet') return { id: 'ABC123' };
    if (path === 'torrents/info/ABC123') return ++infoCount === 1 ? { status: 'waiting_files_selection', files } : { status: 'downloaded', files: files.map((file) => ({ ...file, selected: file.id === 2 ? 1 : 0 })), links: ['https://host.example/episode'] };
    if (path === 'torrents/selectFiles/ABC123') { assert.equal(form.files, '2'); return {}; }
    if (path === 'unrestrict/link') { assert.equal(form.link, 'https://host.example/episode'); return { download: 'https://cdn.example/episode.mkv' }; }
    throw new Error('Unexpected endpoint');
  } });
  assert.equal(result.playbackUrl, 'https://cdn.example/episode.mkv');
  assert.equal(calls.length, 5);
});
test('Torbox uses its torrent file id and returns only the resolved CDN URL', async () => {
  const result = await resolveMovieSource(settings('Torbox'), { hash, type: 'movie' }, { request: async (_provider, _token, path) => {
    if (path === 'torrents/createtorrent') return { success: true, data: { torrent_id: 12 } };
    if (path.startsWith('torrents/mylist')) return { success: true, data: [{ id: 12, download_finished: true, download_present: true, files: [{ id: 4, name: 'Movie.mp4', size: 50 }] }] };
    assert.equal(path, 'torrents/requestdl?torrent_id=12&file_id=4&redirect=false');
    return { success: true, data: 'https://cdn.example/movie.mp4' };
  } });
  assert.equal(result.playbackUrl, 'https://cdn.example/movie.mp4');
});
test('invalid, disabled, unsupported, and missing provider settings cannot start requests', async () => {
  let calls = 0;
  const options = { request: async () => { calls++; } };
  for (const [configuration, input] of [
    [settings('Premiumize'), { hash: 'bad', type: 'movie' }],
    [{ default_provider: 'none' }, { hash, type: 'movie' }],
    [{ default_provider: 'OffCloud' }, { hash, type: 'movie' }],
    [{ default_provider: 'Premiumize', provider_accounts: { Premiumize: { enabled: false, token: 'private' } } }, { hash, type: 'movie' }],
  ]) await assert.rejects(resolveMovieSource(configuration, input, options));
  assert.equal(calls, 0);
});
test('uncached or wrong-episode files never become playable streams', async () => {
  assert.throws(() => chooseVideo([{ path: 'Show.S01E01.mkv' }], { type: 'series', season_int: 1, episode_int: 2 }));
  await assert.rejects(resolveMovieSource(settings('Real-Debrid'), { hash, type: 'movie' }, { request: async (_provider, _token, path) =>
    path === 'torrents/addMagnet' ? { id: 'ABC' } : { status: 'downloading', files: [{ id: 1, path: 'Movie.mp4', bytes: 50 }] } }), { status: 409 });
});
test('provider URL schemes are validated before returning playback', async () => {
  await assert.rejects(resolveMovieSource(settings('Premiumize'), { hash, type: 'movie' }, { request: async () => ({ status: 'success', content: [{ path: 'movie.mp4', link: 'file:///tmp/private.mp4' }] }) }), { status: 502 });
});
