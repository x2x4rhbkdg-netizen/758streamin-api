const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverSources, searchUrl, parseApi, parseHtml, validateSearch, compareSources, mapLimit } = require('./Scraper.cjs');
const { publicAddress, validateUrl, readText } = require('./scraperHttp.cjs');
const hash = 'a'.repeat(40);
const otherHash = 'b'.repeat(40);
const definition = { name: 'Fixture', is_torrent: true, base_url: 'https://example.com',
  search_url_format_movie: { string_format: '/movie/%s.json', replacement: ['imdb_id'] },
  search_url_format_episode: { string_format: '/series/%s:%02d:%02d.json', replacement: ['imdb_id', 'season_int', 'episode_int'] },
  api: { path_to_array: 'streams', path_hash: 'infoHash', path_title_in_array: 'title', path_seeders: 'seeders' } };

test('formats movie/episode identifiers without allowing query injection', () => {
  assert.equal(searchUrl(definition, validateSearch({ type: 'series', imdb_id: 'tt1234567', season_int: 2, episode_int: 3 })),
    'https://example.com/series/tt1234567:02:03.json');
  const titleDefinition = { ...definition, search_url_format_movie: { string_format: '/search?q=%s', replacement: ['title'] } };
  assert.equal(searchUrl(titleDefinition, { type: 'movie', title: 'Example & admin=true' }), 'https://example.com/search?q=Example%20%26%20admin%3Dtrue');
  assert.throws(() => validateSearch({ type: 'series', title: 'Example' }), { status: 400 });
  assert.throws(() => validateSearch({ type: 'movie', imdb_id: 'bad' }), { status: 400 });
});

test('extracts flat and nested JSON hashes with no executable content', () => {
  const flat = parseApi(definition, JSON.stringify({ streams: [{ infoHash: hash, title: 'Example 1080p', seeders: 4 }] }));
  assert.equal(flat[0].hash, hash);
  assert.equal(flat[0].quality, '1080p');
  const nested = { ...definition, api: { path_to_base_array: 'data{}movies', path_to_array: 'torrents', path_hash: 'hash', path_title: 'title' } };
  assert.equal(parseApi(nested, JSON.stringify({ data: { movies: [{ title: 'Example', torrents: [{ hash }] }] } }))[0].title, 'Example');
  assert.equal(parseApi(definition, JSON.stringify({ streams: [{ infoHash: 'invalid' }] })).length, 0);
});

test('extracts HTML selectors, attribute aliases and magnet hashes', () => {
  const htmlDefinition = { name: 'HTML', links_container_path: '.row', magnet_path: 'a[href^=magnet]', magnet_path_attr: 'href',
    title_path: '.title', quality_path: '|title_path|', seeders_path: '.seeds' };
  const sources = parseHtml(htmlDefinition, `<div class="row"><span class="title">Example 720p</span><span class="seeds">6</span><a href="magnet:?xt=urn:btih:${hash}">Link</a></div>`, 'https://example.com');
  assert.equal(sources[0].hash, hash);
  assert.equal(sources[0].seeders, 6);
});

test('parallel scraper failures do not discard good results; deduplicates and filters', async () => {
  const fetchText = async (url) => {
    if (url === 'https://manifest.test') return JSON.stringify({ 1: ['https://defs.test/a', 'https://defs.test/b', 'https://defs.test/broken'] });
    if (url === 'https://defs.test/broken') throw new Error('Failure with private credentials');
    if (url.startsWith('https://defs.test/')) return JSON.stringify(definition);
    return JSON.stringify({ streams: [{ infoHash: hash, title: 'Example 1080p', seeders: 8 }, { infoHash: otherHash, title: 'Example CAM', seeders: 50 }] });
  };
  const result = await discoverSources({ scraper_url: 'https://manifest.test', hide_phrases: 'CAM', max_links: 10 },
    { type: 'movie', imdb_id: 'tt1234567' }, { fetchText });
  assert.equal(result.sources.length, 1);
  assert.equal(result.diagnostics.definition_errors, 1);
  assert.equal(result.playable, false);
  assert.equal(JSON.stringify(result).includes('private credentials'), false);
});

test('series excludes unrelated episodes and season packs', async () => {
  const fetchText = async (url) => url === 'https://manifest.test' ? JSON.stringify({ 1: ['https://defs.test/a'] }) :
    url === 'https://defs.test/a' ? JSON.stringify(definition) : JSON.stringify({ streams: [
      { infoHash: hash, title: 'Example S02E03' }, { infoHash: otherHash, title: 'Example S02E04' },
    ] });
  const result = await discoverSources({ scraper_url: 'https://manifest.test' },
    { type: 'series', imdb_id: 'tt1234567', season_int: 2, episode_int: 3 }, { fetchText });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].hash, hash);
});

test('unrelated movie search results cannot become auto-selection candidates', async () => {
  const fetchText = async (url) => url === 'https://manifest.test' ? JSON.stringify({ 1: ['https://defs.test/a'] }) :
    url === 'https://defs.test/a' ? JSON.stringify(definition) : JSON.stringify({ streams: [
      { infoHash: hash, title: 'Example.Movie.2001.1080p' }, { infoHash: otherHash, title: 'Another Movie 2001 1080p' },
    ] });
  const result = await discoverSources({ scraper_url: 'https://manifest.test' },
    { type: 'movie', imdb_id: 'tt1234567', title: 'Example Movie', year_int: 2001 }, { fetchText });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].hash, hash);
  const wrongYear = await discoverSources({ scraper_url: 'https://manifest.test' },
    { type: 'movie', imdb_id: 'tt1234567', title: 'Example Movie', year_int: 2002 }, { fetchText });
  assert.equal(wrongYear.sources.length, 0);
});

test('sorting respects both priorities and keeps unknown metadata last', () => {
  const settings = { primary_sort: 'quality', primary_sort_direction: 'desc', secondary_sort: 'bitrate', secondary_sort_direction: 'asc' };
  const a = { quality: '1080p', bitrate_mbps: 5, seeders: 0 };
  const b = { quality: '720p', bitrate_mbps: 10, seeders: 0 };
  assert.ok(compareSources(a, b, settings) < 0);
  assert.ok(compareSources(a, { ...a, bitrate_mbps: 8 }, settings) < 0);
  assert.ok(compareSources(a, { ...a, bitrate_mbps: null }, settings) < 0);
});

test('quality sorting does not truncate lower resolutions at the legacy maximum links setting', async () => {
  const streams = Array.from({ length: 24 }, (_, index) => ({
    infoHash: (index + 1).toString(16).padStart(40, '0'),
    title: `Example 2001 ${index < 12 ? '2160p' : index < 20 ? '1080p' : '720p'}`,
  }));
  const fetchText = async (url) => url === 'https://manifest.test' ? JSON.stringify(['https://defs.test/a']) :
    url === 'https://defs.test/a' ? JSON.stringify(definition) : JSON.stringify({ streams });
  const result = await discoverSources({ scraper_url: 'https://manifest.test', max_links: 10 },
    { type: 'movie', imdb_id: 'tt1234567', title: 'Example', year_int: 2001 }, { fetchText });
  assert.equal(result.sources.length, 24);
  assert.deepEqual([...new Set(result.sources.map((item) => item.quality))], ['2160p', '1080p', '720p']);
});

test('bounded concurrency keeps scraper work limited', async () => {
  let active = 0, peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
    active++; peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  });
  assert.equal(peak, 2);
});

test('blocks private, mapped, reserved and non-HTTP destinations', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254',
    '100.64.1.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///etc/passwd', 'http://user:pass@example.com', 'http://example.com:3306']) assert.throws(() => validateUrl(url));
  await assert.rejects(readText('http://127.0.0.1'), /Private scraper destination blocked/);
});
