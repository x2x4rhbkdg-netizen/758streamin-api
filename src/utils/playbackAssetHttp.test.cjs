const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const zlib = require('node:zlib');
const { createPlaybackAssetReader, legacyAssetOrigins } = require('./playbackAssetHttp.cjs');

function fixture(responses = [], addresses = [{ address: '93.184.216.34', family: 4 }]) {
  const calls = [], lookups = [], openedResponses = [];
  const get = (url, options, callback) => {
    calls.push({ url: url.href, options });
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => {
      if (options.signal.aborted) { request.emit('error', new Error('aborted')); return; }
      const spec = responses.shift() || {};
      const response = new PassThrough();
      openedResponses.push(response);
      response.statusCode = spec.status || 200;
      response.headers = spec.headers || {};
      const abort = () => response.destroy(new Error('aborted'));
      options.signal.addEventListener('abort', abort, { once: true });
      response.on('close', () => options.signal.removeEventListener('abort', abort));
      callback(response);
      if (!spec.hang) response.end(spec.body || 'asset');
    });
    return request;
  };
  const read = createPlaybackAssetReader({
    requestHttp: get, requestHttps: get,
    async lookup(hostname) { lookups.push(hostname); return typeof addresses === 'function' ? addresses(hostname) : addresses; },
  });
  return { read, calls, lookups, openedResponses };
}

test('preserves binary bytes, range metadata, custom upstream ports and pins checked DNS', async () => {
  const f = fixture([{ status: 206, body: Buffer.from([0, 255, 42]), headers: {
    'content-type': 'video/mp2t', 'content-length': '3', 'content-range': 'bytes 0-2/9', 'accept-ranges': 'bytes',
  } }]);
  const result = await f.read('http://upstream.example:8080/a.ts', { headers: { Range: 'bytes=0-2' } });
  assert.deepEqual(result.buffer, Buffer.from([0, 255, 42]));
  assert.equal(result.status, 206); assert.equal(result.contentRange, 'bytes 0-2/9');
  assert.equal(result.contentLength, '3'); assert.equal(result.acceptRanges, 'bytes');
  assert.equal(f.calls[0].options.headers.Range, 'bytes=0-2');
  assert.equal(f.calls[0].options.agent.options.keepAlive, true);
  f.calls[0].options.lookup('upstream.example', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
  });
  f.calls[0].options.lookup('upstream.example', { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
  assert.equal(f.lookups.length, 1);
});

test('blocks private, loopback, metadata, mapped IPv4 and special IPv6 literals before connection', async () => {
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '10.0.0.1', '172.16.0.1',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[fc00::1]', '[fe80::1]',
    '[::ffff:127.0.0.1]', '[2001:0db8:0000:0000:0000:0000:0000:0001]', '[2002:7f00:1::]', '[3fff::1]']) {
    const f = fixture();
    await assert.rejects(f.read(`http://${host}/a`), error => error.status === 403, host);
    assert.equal(f.calls.length, 0, host);
  }
});

test('retains all validated public addresses for dual-stack connection fallback', async () => {
  const addresses = [{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }];
  const f = fixture([], addresses);
  await f.read('https://upstream.example/a');
  f.calls[0].options.lookup('upstream.example', { all: true }, (error, result) => {
    assert.equal(error, null); assert.deepEqual(result, addresses);
  });
});

test('rejects mixed public/private DNS answers and later private redirect resolutions', async () => {
  const mixed = fixture([], [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }]);
  await assert.rejects(mixed.read('https://mixed.example/a'), error => error.status === 403);
  assert.equal(mixed.calls.length, 0);
  let resolutions = 0;
  const f = fixture([{ status: 302, headers: { location: '/next' } }], () => [{
    address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4,
  }]);
  await assert.rejects(f.read('https://upstream.example/a'), error => error.status === 403);
  assert.equal(f.calls.length, 1);
});

test('server-issued assets can follow public CDN redirects but never private destinations', async () => {
  const f = fixture([{ status: 302, headers: { location: 'https://cdn.example/a.ts' } }, { body: 'video' }]);
  const result = await f.read('https://upstream.example/a');
  assert.equal(result.url, 'https://cdn.example/a.ts'); assert.equal(result.buffer.toString(), 'video');
  const blocked = fixture([{ status: 302, headers: { location: 'http://169.254.169.254/latest' } }]);
  await assert.rejects(blocked.read('https://upstream.example/a'), error => error.status === 403);
  assert.equal(blocked.calls.length, 1);
});

test('legacy allowlist enforces exact scheme, host and port on initial request and every redirect', async () => {
  const allowedOrigins = legacyAssetOrigins('http://provider.example:8080/path', 'https://cdn.example');
  for (const url of ['http://provider.example:80/a', 'https://provider.example:8080/a', 'http://provider.example.attacker/a', 'https://other.example/a']) {
    const f = fixture();
    await assert.rejects(f.read(url, {}, { allowedOrigins }), error => error.status === 403);
    assert.equal(f.calls.length, 0);
  }
  const blocked = fixture([{ status: 302, headers: { location: 'https://other.example/a' } }]);
  await assert.rejects(blocked.read('http://provider.example:8080/a', {}, { allowedOrigins }), error => error.status === 403);
  assert.equal(blocked.calls.length, 1);
  const approved = fixture([{ status: 302, headers: { location: 'https://cdn.example/a' } }, {}]);
  assert.equal((await approved.read('http://provider.example:8080/a', {}, { allowedOrigins })).url, 'https://cdn.example/a');
});

test('rejects URL credentials, non-HTTP schemes and excessive redirect chains', async () => {
  for (const url of ['file:///etc/passwd', 'http://user:secret@upstream.example/a', 'not-a-url']) {
    const f = fixture(); await assert.rejects(f.read(url), error => error.status === 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/loop' } })));
  await assert.rejects(f.read('https://upstream.example/a'), error => error.status === 502);
  assert.equal(f.calls.length, 6);
});

test('bounds raw and decompressed bodies and preserves supported compressed responses', async () => {
  for (const spec of [{ body: '12345' }, { headers: { 'content-length': '5' } },
    { body: zlib.gzipSync('x'.repeat(1000)), headers: { 'content-encoding': 'gzip' } }]) {
    await assert.rejects(fixture([spec]).read('https://upstream.example/a', {}, { maxBytes: 4 }), error => error.status === 502);
  }
  // The wire body is small enough; the expanded body alone crosses this limit.
  await assert.rejects(fixture([{ body: zlib.gzipSync('x'.repeat(1000)), headers: { 'content-encoding': 'gzip' } }])
    .read('https://upstream.example/a', {}, { maxBytes: 100 }), error => error.status === 502);
  const result = await fixture([{ body: zlib.gzipSync('manifest'), headers: { 'content-encoding': 'gzip', 'content-length': '28' } }]).read('https://upstream.example/a');
  assert.equal(result.buffer.toString(), 'manifest'); assert.equal(result.contentLength, '');
});

test('total deadline covers stalled DNS and stalled bodies, and caller cancellation works', async () => {
  const stalled = createPlaybackAssetReader({ lookup: () => new Promise(() => {}) });
  await assert.rejects(stalled('https://upstream.example/a', {}, { timeoutMs: 10 }), error => error.status === 504);
  await assert.rejects(fixture([{ hang: true }]).read('https://upstream.example/a', {}, { timeoutMs: 10 }), error => error.status === 504);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture().read('https://upstream.example/a', { signal: controller.signal }), error => error.status === 504);
});

test('caller cancellation destroys an in-flight response and returns before its deadline', async () => {
  const f = fixture([{ hang: true }]);
  const controller = new AbortController();
  const pending = f.read('https://upstream.example/a', { signal: controller.signal }, { timeoutMs: 12000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.openedResponses.length, 1);
  f.openedResponses[0].write(Buffer.from('partial segment'));
  const rejection = assert.rejects(pending, error => error.status === 504);
  controller.abort();
  await rejection;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.openedResponses[0].destroyed, true);
});
