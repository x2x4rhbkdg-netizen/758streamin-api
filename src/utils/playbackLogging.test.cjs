const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createPlaybackLogging } = require('./playbackLogging.cjs');
const { createHlsUpstreamDiagnostics } = require('./hlsUpstreamDiagnostics.cjs');

function fixture() {
  let time = 0;
  const logs = [];
  const logger = { log: (tag, value) => logs.push({ tag, ...JSON.parse(value) }),
    warn: (tag, value) => logs.push({ tag, ...JSON.parse(value) }) };
  const logging = createPlaybackLogging({ secret: 'test-only-log-key', logger, now: () => time });
  const diagnostics = createHlsUpstreamDiagnostics({ logging, logger, now: () => time });
  function request(path, fn) {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    let result;
    logging.middleware({ path, headers: { 'x-request-id': 'untrusted-secret' } }, res, () => { result = fn(res); });
    return Promise.resolve(result);
  }
  function finish(res, status = 200) { res.statusCode = status; res.writableFinished = true; res.emit('finish'); res.emit('close'); }
  return { logs, logging, diagnostics, request, finish, advance: value => { time = value; } };
}

test('references are credential-free, stable with a key and separated by origin and key', () => {
  const f = fixture();
  const first = f.logging.source('https://USER:PASS@provider.example/live/USER/PASS/12.m3u8?token=SECRET');
  assert.deepEqual(first, f.logging.source('https://provider.example/another?password=OTHER'));
  assert.notEqual(first.source_ref, f.logging.source('http://provider.example/path').source_ref);
  assert.notEqual(first.source_ref, createPlaybackLogging({ secret: 'different' }).source('https://provider.example').source_ref);
  assert.deepEqual(f.logging.source('malformed SECRET'), {});
  assert.doesNotMatch(JSON.stringify(first), /USER|PASS|SECRET|provider|live/);
});

test('concurrent requests retain independent stream, request and session correlation', async () => {
  const f = fixture();
  const run = id => f.request('/playback/embedded-hls', async res => {
    f.logging.identify({ stream_id: id, type: 'live' }, { platform: 'android_tv' }, `JWT-SECRET-${id}`);
    f.logging.stage('manifest');
    f.logging.target(`https://provider.example/live/user/password/${id}.m3u8`);
    await new Promise(resolve => setImmediate(resolve));
    f.diagnostics.failure({ status: 503, message: 'SECRET', body: 'SECRET' },
      { startedAt: 0, targetUrl: 'https://provider.example/user/password', candidate: 1, totalCandidates: 2 });
    f.finish(res, 503);
  });
  await Promise.all([run('12'), run('13')]);
  const attempts = f.logs.filter(log => log.tag === '[hls-upstream-failure]');
  const outcomes = f.logs.filter(log => log.event === 'request_complete');
  assert.equal(attempts.length, 2); assert.equal(outcomes.length, 2);
  assert.notEqual(attempts[0].request_id, attempts[1].request_id);
  for (const attempt of attempts) {
    const outcome = outcomes.find(log => log.request_id === attempt.request_id);
    assert.equal(outcome.stream_id, attempt.stream_id);
    assert.equal(outcome.session_ref, attempt.session_ref);
    assert.equal(outcome.outcome, 'failed'); assert.equal(outcome.stage, 'manifest');
    assert.equal(outcome.failed_attempts, 1);
  }
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|password|provider\.example|untrusted/);
});

test('recovered fallback and nested playlist failure are distinct from terminal failures', async () => {
  const f = fixture();
  await f.request('/playback/embedded-hls', res => {
    f.logging.stage('nested_manifest');
    f.diagnostics.failure({ status: 503 }, { startedAt: 0, targetUrl: 'https://first.example' });
    f.logging.target('https://second.example');
    f.finish(res);
  });
  const outcome = f.logs.at(-1);
  assert.equal(outcome.outcome, 'recovered'); assert.equal(outcome.failed_attempts, 1);
  assert.equal(outcome.stage, 'nested_manifest');
  assert.notEqual(outcome.source_ref, outcome.last_failed_source_ref);
});

test('segments and keys stay quiet on success but emit failures and aborted requests once', async () => {
  const f = fixture();
  await f.request('/playback/embedded-hls-asset', res => f.finish(res));
  assert.equal(f.logs.length, 0);
  await f.request('/playback/hls-asset', res => {
    f.logging.stage('key'); f.finish(res, 503);
  });
  assert.equal(f.logs.at(-1).stage, 'key'); assert.equal(f.logs.at(-1).outcome, 'failed');
  await f.request('/playback/hls-asset', res => { res.emit('close'); res.emit('close'); });
  assert.equal(f.logs.filter(log => log.outcome === 'aborted').length, 1);
});

test('debug logs discard arbitrary fields and use the same non-token session reference', async () => {
  const f = fixture();
  const token = 'PRIVATE-JWT';
  const fingerprint = createHash('sha256').update(token).digest().subarray(0, 16).toString('base64url');
  f.logging.debug('playback_token_issued', { token: fingerprint, deviceId: 999, streamId: '12', message: 'PRIVATE', url: 'PRIVATE' });
  await f.request('/playback/hls', res => {
    f.logging.identify({ stream_id: '12', type: 'live' }, { platform: 'android_tv' }, token);
    f.finish(res);
  });
  assert.equal(f.logs[0].session_ref, f.logs[1].session_ref);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|deviceId|999|message|"url"|"token"/);
  assert.ok(!JSON.stringify(f.logs).includes(fingerprint));
});

test('rate limits keep failure outcomes independent of routine noise and report suppressed events', async () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) f.logging.debug('playback_token_cached');
  assert.equal(f.logs.length, 60);
  await f.request('/playback/hls', res => f.finish(res, 503));
  assert.equal(f.logs.at(-1).outcome, 'failed');
  f.advance(60000); f.logging.debug('playback_token_cached');
  assert.equal(f.logs.at(-1).suppressed_since_last_log, 5);
});

test('logger exceptions never change request execution', async () => {
  const logging = createPlaybackLogging({ logger: { log() { throw new Error('broken'); } } });
  const res = Object.assign(new EventEmitter(), { statusCode: 503, writableFinished: true });
  assert.doesNotThrow(() => logging.middleware({ path: '/playback/hls' }, res, () => res.emit('finish')));
});
