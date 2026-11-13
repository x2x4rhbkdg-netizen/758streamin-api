const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHlsUpstreamDiagnostics } = require('./hlsUpstreamDiagnostics.cjs');

test('classifies failures with elapsed time and safe fields, never raw provider details', () => {
  let time = 0; const logs = [];
  const diagnostics = createHlsUpstreamDiagnostics({ now: () => time, logger: { warn: (...args) => logs.push(args) } });
  const cases = [
    [{ status: 503 }, {}, 'http'],
    [{ name: 'AbortError' }, { timedOut: true }, 'timeout'],
    [{ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, {}, 'timeout'],
    [{ name: 'AbortError' }, {}, 'aborted'],
    [{ cause: { code: 'ENOTFOUND' } }, {}, 'dns'],
    [{ cause: { code: 'CERT_HAS_EXPIRED' } }, {}, 'tls'],
    [{ cause: { code: 'ECONNRESET' } }, {}, 'connection'],
    [{ name: 'https://private.example/user/secret', cause: { code: 'secret' } }, {}, 'network'],
  ];
  for (const [error, options, expected] of cases) {
    time += 125;
    diagnostics.failure({ message: 'https://private.example/user/secret?token=secret', url: 'private', body: 'private', ...error },
      { startedAt: time - 125, candidate: 2, totalCandidates: 3, timeoutMs: 12000, ...options });
    const [tag, encoded] = logs.at(-1);
    const record = JSON.parse(encoded);
    assert.equal(tag, '[hls-upstream-failure]'); assert.equal(record.failure_type, expected);
    assert.equal(record.elapsed_ms, 125); assert.equal(record.timeout_ms, 12000);
    assert.equal(record.candidate, 2); assert.equal(record.totalCandidates, 3);
  }
  assert.doesNotMatch(JSON.stringify(logs), /private|secret|https/);
});

test('bounded per-worker rate includes suppressed count on the next emitted log', () => {
  let time = 0; const logs = [];
  const diagnostics = createHlsUpstreamDiagnostics({ now: () => time, maxPerMinute: 2, logger: { warn: (_tag, value) => logs.push(JSON.parse(value)) } });
  for (let i = 0; i < 5; i++) diagnostics.failure({}, { startedAt: 0, candidate: 1, totalCandidates: 1 });
  assert.equal(logs.length, 2);
  time = 60000;
  diagnostics.failure({}, { startedAt: 59900, candidate: 1, totalCandidates: 1 });
  assert.equal(logs.length, 3); assert.equal(logs[2].suppressed_since_last_log, 3);
  assert.equal(logs[2].elapsed_ms, 100);
});

test('a logging failure cannot throw into the playback path', () => {
  const diagnostics = createHlsUpstreamDiagnostics({ logger: { warn() { throw new Error('broken logger'); } } });
  assert.doesNotThrow(() => diagnostics.failure({}, { startedAt: diagnostics.now(), candidate: 1, totalCandidates: 1 }));
});

function fetchFixture(results) {
  const source = fs.readFileSync(require.resolve('../routes/playback.routes.cjs'), 'utf8');
  const start = source.indexOf('async function fetchTextWithResolvedUrl(');
  const end = source.indexOf('\nasync function fetchBinaryWithResolvedUrl(', start);
  const calls = [], failures = [];
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    playbackLogging: { stage() {}, target() {} },
    hlsUpstreamDiagnostics: { now: () => 0, failure: (error, details) => failures.push({ error, details }) },
    fetch: async (url, init) => {
      calls.push({ url, init }); const value = results.shift();
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(url, init);
      return { ok: value.status < 400, status: value.status, url, text: async () => value.text || 'manifest', headers: { get: () => 'application/vnd.apple.mpegurl' } };
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: context.fetchTextWithResolvedUrl, calls, failures };
}

test('HTTP 5xx fallback records each failed candidate including intermediate failures; success stays quiet', async () => {
  const f = fetchFixture([{ status: 503 }, { status: 502 }, { status: 200 }]);
  const result = await f.run(['https://one', 'https://two', 'https://three'], {}, { timeoutMs: 12000 });
  assert.equal(result.text, 'manifest'); assert.equal(f.calls.length, 3); assert.equal(f.failures.length, 2);
  assert.equal(f.failures[0].details.candidate, 1); assert.equal(f.failures[1].details.candidate, 2);
  assert.equal(f.failures[1].details.totalCandidates, 3); assert.equal(f.failures[1].details.timeoutMs, 12000);
});

test('HTTP 4xx still stops fallback immediately; network failures still try the next candidate', async () => {
  const denied = fetchFixture([{ status: 403 }, { status: 200 }]);
  await assert.rejects(denied.run(['https://one', 'https://two']), error => error.status === 403);
  assert.equal(denied.calls.length, 1); assert.equal(denied.failures.length, 1);
  const network = fetchFixture([new TypeError('fetch failed'), { status: 200 }]);
  await network.run(['https://one', 'https://two']);
  assert.equal(network.calls.length, 2); assert.equal(network.failures.length, 1);
});

test('exhausted candidates throw the original error, not a logging replacement', async () => {
  const error = new TypeError('fetch failed');
  const f = fetchFixture([error]);
  await assert.rejects(f.run(['https://one']), value => value === error);
  assert.equal(f.failures.length, 1);
});

test('the existing abort deadline is unchanged and its failure is marked as a timeout', async () => {
  const f = fetchFixture([(_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
  })]);
  await assert.rejects(f.run(['https://one'], {}, { timeoutMs: 5 }), error => error.name === 'AbortError');
  assert.equal(f.failures.length, 1); assert.equal(f.failures[0].details.timedOut, true);
  assert.equal(f.failures[0].details.timeoutMs, 5);
});
