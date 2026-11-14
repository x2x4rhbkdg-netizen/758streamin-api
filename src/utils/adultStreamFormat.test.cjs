const test = require('node:test');
const assert = require('node:assert/strict');
const { isHlsMedia, probeAdultStreamFormat } = require('./adultStreamFormat.cjs');
const { createPlaybackAssetReader } = require('./playbackAssetHttp.cjs');

test('HLS format detection uses only playlist extensions and recognized MIME types', () => {
  assert.equal(isHlsMedia('https://cdn.example/path/MASTER.M3U8?token=SECRET'), true);
  assert.equal(isHlsMedia('https://cdn.example/opaque', 'application/vnd.apple.mpegurl; charset=utf-8'), true);
  assert.equal(isHlsMedia('https://cdn.example/video.mp4?title=master.m3u8'), false);
  assert.equal(isHlsMedia('https://cdn.example/opaque', 'text/html; name=m3u8'), false);
  assert.equal(isHlsMedia('not a URL'), false);
});

test('redirected extensionless HLS is detected without reading a media body', async () => {
  const calls = [];
  const format = await probeAdultStreamFormat('https://initial.example/play', { Cookie: 'SECRET' }, { reader: async (url, init, options) => {
    calls.push({ url, init, options });
    assert.equal(options.headersOnly, true); assert.equal(init.method, 'HEAD');
    assert.equal(options.destinationHeaders(url).cookie, 'SECRET');
    assert.deepEqual(options.destinationHeaders('https://cdn.example/final'), {});
    return { url: 'https://cdn.example/opaque', contentType: 'application/x-mpegurl' };
  } });
  assert.equal(format, 'hls'); assert.equal(calls.length, 1);
});

test('unsupported or inconclusive HEAD falls back to GET headers and MP4 remains a file', async () => {
  for (const rejectHead of [true, false]) {
    const methods = [];
    const format = await probeAdultStreamFormat('https://cdn.example/opaque', {}, { reader: async (_url, init, options) => {
      methods.push(init.method); assert.equal(options.headersOnly, true);
      if (init.method === 'HEAD') {
        if (rejectHead) throw Object.assign(new Error('HEAD unsupported'), { status: 405 });
        return { url: 'https://cdn.example/opaque', contentType: 'application/octet-stream' };
      }
      return { url: 'https://cdn.example/opaque', contentType: 'application/vnd.apple.mpegurl' };
    } });
    assert.equal(format, 'hls'); assert.deepEqual(methods, ['HEAD', 'GET']);
  }
  assert.equal(await probeAdultStreamFormat('https://cdn.example/video.mp4', {}, { reader: async () => ({ url: 'https://cdn.example/video.mp4', contentType: 'video/mp4' }) }), 'file');
});

test('probe failures are bounded, non-fatal and do not disclose URLs or headers', async () => {
  assert.equal(await probeAdultStreamFormat('https://cdn.example/opaque', {}, { timeoutMs: 5,
    reader: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })) }), 'unknown');
  assert.equal(await probeAdultStreamFormat('https://cdn.example/opaque', {}, { reader: async () => { throw new Error('SECRET'); } }), 'unknown');
  let requests = 0;
  const reader = createPlaybackAssetReader({ lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    requestHttps: () => { requests++; throw new Error('Must not connect'); } });
  assert.equal(await probeAdultStreamFormat('https://private.example/opaque', {}, { reader }), 'unknown');
  assert.equal(requests, 0);
});
