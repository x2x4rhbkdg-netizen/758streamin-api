const test = require('node:test');
const assert = require('node:assert/strict');
const { services, browse } = require('./streamingServices.cjs');

test('same-name regional IDs share one icon and retain both discovery and search availability', async () => {
  const settings = { tmdb_read_access_token: 'duplicate-prime-test' };
  const request = async (_settings, path, params) => {
    if (path === 'watch/providers/movie') return { results: [
      { provider_id: 119, provider_name: 'Amazon Prime Video' },
      { provider_id: 9, provider_name: 'Amazon Prime Video' },
      { provider_id: 2100, provider_name: 'Amazon Prime Video with Ads' },
    ] };
    if (path === 'watch/providers/regions') return { results: [{ iso_3166_1: 'US' }] };
    if (path === 'discover/movie') {
      assert.equal(params.with_watch_providers, '9|119');
      return { results: [{ id: 10 }] };
    }
    if (path === 'search/movie') return { results: [{ id: 10 }] };
    return { results: { US: { flatrate: [{ provider_id: 119 }] } } };
  };
  const list = await services(settings, 'movie', request);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].ids, [9, 119]);
  assert.equal((await browse(settings, 'movie', request, { service: 9, page: 1, category: 'popular', query: '' })).results.length, 1);
  assert.equal((await browse(settings, 'movie', request, { service: 119, page: 1, category: 'popular', query: 'example' })).results.length, 1);
});

test('global service pages merge every supported region, deduplicate and share cached requests', async () => {
  const settings = { tmdb_read_access_token: 'global-test' };
  const calls = [];
  const request = async (_settings, path, params) => {
    calls.push({ path, params });
    if (path === 'watch/providers/movie') return { results: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/logo.png', display_priorities: { US: 1 } }] };
    if (path === 'watch/providers/regions') return { results: [{ iso_3166_1: 'US' }, { iso_3166_1: 'LC' }] };
    return { total_pages: 3, results: [{ id: 1, popularity: 4 }, { id: params.watch_region === 'US' ? 2 : 3, popularity: 1 }, { id: 4, adult: true }] };
  };
  const options = { service: 8, page: 1, category: 'popular', query: '' };
  const [first, second] = await Promise.all([browse(settings, 'movie', request, options), browse(settings, 'movie', request, options)]);
  assert.deepEqual(first.results.map(value => value.id), [1, 2, 3]);
  assert.equal(first, second);
  assert.deepEqual(calls.filter(value => value.path === 'discover/movie').map(value => value.params.watch_region).sort(), ['LC', 'US']);
  assert.equal(calls.filter(value => value.path === 'discover/movie').length, 2);
  assert.equal(first.total_pages, 3);
  assert.equal((await services(settings, 'movie', request))[0].logo, 'https://image.tmdb.org/t/p/w92/logo.png');
});

test('service search checks matching titles across all availability types and countries', async () => {
  const request = async (_settings, path) => {
    if (path === 'watch/providers/tv') return { results: [{ provider_id: 9, provider_name: 'Prime Video' }] };
    if (path === 'watch/providers/regions') return { results: [{ iso_3166_1: 'US' }] };
    if (path === 'search/tv') return { total_pages: 2, results: [{ id: 10 }, { id: 11 }] };
    return { results: { LC: { rent: [{ provider_id: path.includes('/10/') ? 9 : 8 }] } } };
  };
  const result = await browse({ tmdb_read_access_token: 'search-test' }, 'tv', request, { service: 9, page: 1, category: 'popular', query: 'example' });
  assert.deepEqual(result.results.map(value => value.id), [10]);
  assert.equal(result.total_pages, 2);
});

test('partial availability is marked and failed requests never leak upstream errors', async () => {
  const request = async (_settings, path, params) => {
    if (path === 'watch/providers/movie') return { results: [{ provider_id: 8, provider_name: 'Netflix' }] };
    if (path === 'watch/providers/regions') return { results: [{ iso_3166_1: 'US' }, { iso_3166_1: 'LC' }] };
    if (params.watch_region === 'LC') throw new Error('secret');
    return { results: [{ id: 1 }] };
  };
  const result = await browse({ tmdb_read_access_token: 'partial-test' }, 'movie', request, { service: 8, page: 1, category: 'popular', query: '' });
  assert.match(result.notice, /regions.*unavailable/);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
