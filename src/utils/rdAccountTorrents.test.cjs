const test = require('node:test');
const assert = require('node:assert/strict');
const { readRdAccountTorrents, createRdDiagnostics, PAGE_SIZE, MAX_PAGES } = require('./rdAccountTorrents.cjs');
const { lookupProviders, resolveMovieSource } = require('./movieResolver.cjs');
const { createAvailabilityCache } = require('./movieProviderScheduling.cjs');
const hash = 'a'.repeat(40), other = 'b'.repeat(40);
const settings = { provider_accounts: { 'Real-Debrid': { enabled: true, token: 'PRIVATE-TOKEN' } } };
const row = id => ({ id: String(id), hash: other, status: 'downloaded', filename: 'PRIVATE-TITLE', links: ['https://PRIVATE.example/'] });
function diagnostics() {
  const logs = [];
  const diagnostic = createRdDiagnostics({ logger: { warn: (_tag, text) => logs.push(JSON.parse(text)) }, now: () => 100 });
  return { logs, diagnostic };
}

test('RD walks pages, projects minimal fields, lowercases hashes and handles an exact-page boundary', async () => {
  const paths = [], { logs, diagnostic } = diagnostics();
  const result = await readRdAccountTorrents(async path => {
    paths.push(path);
    return paths.length === 1 ? Array.from({ length: PAGE_SIZE }, (_, i) => ({ ...row(i), hash: other.toUpperCase() })) : [];
  }, { diagnostics: diagnostic });
  assert.deepEqual(paths, ['torrents?limit=250&page=1', 'torrents?limit=250&page=2']);
  assert.equal(result.length, PAGE_SIZE);
  assert.deepEqual(result[0], { id: '0', hash: other, status: 'downloaded' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|filename|links/); assert.equal(logs.length, 0);
});

test('RD deduplicates overlaps but rejects a repeated full page without silently marking missing hashes uncached', async () => {
  let calls = 0;
  const first = Array.from({ length: PAGE_SIZE }, (_, i) => row(i));
  const result = await readRdAccountTorrents(async () => ++calls === 1 ? first : [row(0), row(250)], { diagnostics: diagnostics().diagnostic });
  assert.equal(result.length, 251);
  const { logs, diagnostic } = diagnostics();
  calls = 0;
  await assert.rejects(readRdAccountTorrents(async () => { calls++; return first; }, { diagnostics: diagnostic }),
    error => error.rdFailureKind === 'repeated_page');
  assert.equal(calls, 2); assert.equal(logs[0].category, 'repeated_page');
});

test('pending account conversions without a usable hash do not break unrelated ready matches', async () => {
  const result = await readRdAccountTorrents(async () => [
    { id: 'PENDING', status: 'magnet_conversion', hash: null }, row('READY'),
  ], { diagnostics: diagnostics().diagnostic });
  assert.deepEqual(result, [{ id: 'READY', hash: other, status: 'downloaded' }]);
});

test('RD hard page cap, invalid responses and aborted walks fail explicitly', async () => {
  let calls = 0;
  const { logs, diagnostic } = diagnostics();
  await assert.rejects(readRdAccountTorrents(async () => {
    const offset = calls++ * PAGE_SIZE;
    return Array.from({ length: PAGE_SIZE }, (_, i) => row(offset + i));
  }, { diagnostics: diagnostic }), error => error.rdFailureKind === 'pagination_limit');
  assert.equal(calls, MAX_PAGES); assert.equal(logs[0].pages_completed, MAX_PAGES);
  for (const bad of [{ error: 'PRIVATE' }, [null], [{ ...row(1), id: 'https://PRIVATE' }], [{ ...row(1), hash: 'PRIVATE' }]]) {
    await assert.rejects(readRdAccountTorrents(async () => bad, { diagnostics: diagnostic }), error => error.rdFailureKind === 'invalid_response');
  }
  const controller = new AbortController(); calls = 0;
  await assert.rejects(readRdAccountTorrents(async () => {
    calls++; controller.abort(); return Array.from({ length: PAGE_SIZE }, (_, i) => row(i));
  }, { signal: controller.signal, diagnostics: diagnostic }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|https:|hash|filename/);
});

test('RD diagnostics allowlist status/codes, bound volume, and never propagate logger errors', () => {
  let time = 0; const logs = [];
  const d = createRdDiagnostics({ logger: { warn: (_tag, text) => logs.push(JSON.parse(text)) }, now: () => time, maxPerMinute: 1 });
  const error = Object.assign(new Error('PRIVATE URL and token'), { rdFailureKind: 'http', upstreamStatus: 401, rdErrorCode: 8 });
  const context = { page: 2, completed: 1, startedAt: 0 };
  d.failure(error, context); d.failure(error, context);
  assert.equal(logs.length, 1); assert.equal(logs[0].rd_error_code, 8); assert.equal(logs[0].http_status, 401);
  time = 60001;
  d.failure({ message: 'PRIVATE', rdFailureKind: 'PRIVATE', cause: { code: 'PRIVATE' }, rdErrorCode: 'PRIVATE' }, { page: 'PRIVATE', completed: 'PRIVATE', startedAt: 0 });
  assert.equal(logs[1].suppressed_since_last_log, 1);
  assert.equal(logs[1].page, undefined); assert.equal(logs[1].category, 'network');
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|token|URL/);
  const broken = createRdDiagnostics({ logger: { warn() { throw Error('PRIVATE'); } } });
  assert.doesNotThrow(() => broken.failure(error, context));
});

test('production RD adapter paginates a formerly oversized account list once per multi-batch search', async () => {
  const original = global.fetch;
  const paths = [];
  const rows = Array.from({ length: 5000 }, (_, i) => ({ ...row(i), filename: 'x'.repeat(450) }));
  rows.at(-1).hash = hash;
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024);
  global.fetch = async (url, options) => {
    assert.equal(url.origin, 'https://api.real-debrid.com'); assert.equal(options.headers.Authorization, 'Bearer PRIVATE-TOKEN');
    assert.equal(url.searchParams.get('limit'), '250');
    const page = Number(url.searchParams.get('page')); paths.push(page);
    return new Response(JSON.stringify(rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)));
  };
  try {
    const sources = Array.from({ length: 225 }, (_, i) => ({ hash: i === 224 ? hash : i.toString(16).padStart(40, '0') }));
    const result = await lookupProviders(settings, sources, { availabilityCache: createAvailabilityCache() });
    assert.deepEqual(paths, Array.from({ length: 21 }, (_, i) => i + 1));
    assert.deepEqual(result.available[hash], ['Real-Debrid']);
    assert.equal(result.provider_status['Real-Debrid'], 'on_demand');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|filename|https:/);
  } finally { global.fetch = original; }
});

test('RD playback resolves a ready match on a later page without adding a torrent', async () => {
  const original = global.fetch; const calls = [];
  global.fetch = async url => {
    calls.push(url.pathname);
    let data;
    if (url.pathname.endsWith('/torrents')) data = Number(url.searchParams.get('page')) === 1
      ? Array.from({ length: PAGE_SIZE }, (_, i) => row(i)) : [{ id: 'READY', hash, status: 'downloaded' }];
    else if (url.pathname.endsWith('/info/READY')) data = { status: 'downloaded', files: [{ id: 1, selected: 1, path: 'Movie.mp4' }], links: ['https://host.example/file'] };
    else { assert.ok(url.pathname.endsWith('/unrestrict/link')); data = { download: 'https://cdn.example/movie.mp4' }; }
    return new Response(JSON.stringify(data));
  };
  try {
    const result = await resolveMovieSource(settings, { hash, type: 'movie', provider: 'Real-Debrid' }, { availabilityCache: createAvailabilityCache() });
    assert.equal(result.playbackUrl, 'https://cdn.example/movie.mp4');
    assert.equal(calls.filter(path => path.endsWith('/torrents')).length, 4);
    assert.equal(calls.some(path => path.includes('addMagnet')), false);
  } finally { global.fetch = original; }
});

test('RD HTTP, parsing, size and network failures log only bounded safe categories', async () => {
  const original = global.fetch, warn = console.warn, logs = [];
  console.warn = (tag, text) => { if (tag === '[rd-account-check-failure]') logs.push(JSON.parse(text)); };
  const cases = [
    ['http', 'credential_rejected', () => new Response('{"error":"PRIVATE","error_code":8}', { status: 401 }), 401, 8],
    ['http', 'credential_rejected', () => new Response('{"error":"PRIVATE"}', { status: 403 }), 403],
    ['http', 'rate_limited', () => new Response('{"error":"PRIVATE"}', { status: 429 }), 429],
    ['http', 'unavailable', () => new Response('<html>PRIVATE</html>', { status: 503 }), 503],
    ['invalid_json', 'unavailable', () => new Response('PRIVATE not JSON'), 200],
    ['response_too_large', 'unavailable', () => new Response(JSON.stringify([{ ...row(1), filename: 'PRIVATE'.repeat(350000) }])), 200],
    ['network', 'unavailable', () => { throw Object.assign(new Error('PRIVATE network URL'), { cause: { code: 'ENOTFOUND' } }); }],
  ];
  try {
    for (const [kind, status, response, http, rdCode] of cases) {
      global.fetch = async () => response();
      const cache = createAvailabilityCache();
      const result = await lookupProviders(settings, [{ hash }], { availabilityCache: cache });
      assert.equal(result.provider_status['Real-Debrid'], status);
      assert.deepEqual(result.available, {}); assert.deepEqual(result.on_demand, {});
      assert.equal(cache.get('Real-Debrid', 'PRIVATE-TOKEN', hash), undefined);
      const record = logs.at(-1);
      assert.equal(record.category, kind); assert.equal(record.http_status, http);
      assert.equal(record.rd_error_code, rdCode);
      assert.equal(record.page, 1); assert.equal(record.pages_completed, 0);
    }
    assert.equal(logs.length, cases.length);
    assert.equal(logs.at(-1).network_code, 'ENOTFOUND');
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|https:|filename|\.example|error_message/);
  } finally { global.fetch = original; console.warn = warn; }
});

test('a later-page failure neither caches partial readiness nor prepares unverified sources', async () => {
  const original = global.fetch, warn = console.warn, logs = [];
  console.warn = (tag, text) => { if (tag === '[rd-account-check-failure]') logs.push(JSON.parse(text)); };
  let calls = 0;
  global.fetch = async url => {
    calls++;
    assert.ok(url.pathname.endsWith('/torrents'));
    return calls === 1 ? new Response(JSON.stringify(Array.from({ length: PAGE_SIZE }, (_, i) => ({ ...row(i), hash }))))
      : new Response('{"error":"PRIVATE"}', { status: 503 });
  };
  try {
    const cache = createAvailabilityCache();
    const result = await lookupProviders(settings, [{ hash }], { availabilityCache: cache });
    assert.equal(calls, 2); assert.equal(result.provider_status['Real-Debrid'], 'unavailable');
    assert.deepEqual(result.available, {}); assert.deepEqual(result.on_demand, {});
    assert.equal(cache.get('Real-Debrid', 'PRIVATE-TOKEN', hash), undefined);
    assert.equal(logs[0].page, 2); assert.equal(logs[0].pages_completed, 1);
  } finally { global.fetch = original; console.warn = warn; }
});

test('pagination reuses the caller signal and stops fetching when the search is cancelled', async () => {
  const original = global.fetch, warn = console.warn, logs = [], controller = new AbortController();
  console.warn = (tag, text) => { if (tag === '[rd-account-check-failure]') logs.push(JSON.parse(text)); };
  let calls = 0, requestSignal;
  global.fetch = async (_url, options) => {
    calls++;
    if (requestSignal) assert.equal(options.signal, requestSignal);
    requestSignal = options.signal;
    if (calls === 2) controller.abort();
    return new Response(JSON.stringify(Array.from({ length: PAGE_SIZE }, (_, i) => row(i + calls * PAGE_SIZE))));
  };
  try {
    const result = await lookupProviders(settings, [{ hash }], { signal: controller.signal, availabilityCache: createAvailabilityCache() });
    assert.equal(calls, 2); assert.equal(requestSignal.aborted, true);
    assert.equal(result.provider_status['Real-Debrid'], 'timed_out');
    assert.equal(logs[0].category, 'timeout'); assert.deepEqual(result.on_demand, {});
  } finally { global.fetch = original; console.warn = warn; }
});
