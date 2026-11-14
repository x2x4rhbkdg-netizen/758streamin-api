const { createPlaybackAssetReader } = require('./playbackAssetHttp.cjs');
const { adultStreamUrl, adultRequestPolicy, headersForDestination } = require('./adultStreamPolicy.cjs');
const readAsset = createPlaybackAssetReader();

function isHlsMedia(url, contentType = '') {
  const mime = String(contentType).split(';')[0].trim().toLowerCase();
  if (['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime)) return true;
  try { return /\.m3u8?$/i.test(new URL(url).pathname); } catch { return false; }
}

async function probeAdultStreamFormat(url, headers, { reader = readAsset, timeoutMs = 4000 } = {}) {
  if (isHlsMedia(url)) return 'hls';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    const policy = adultRequestPolicy(url, headers);
    for (const method of ['HEAD', 'GET']) {
      if (controller.signal.aborted) return 'unknown';
      try {
        const result = await reader(url, { method, signal: controller.signal }, {
          headersOnly: true, maxRedirects: 3, timeoutMs: Math.max(1, deadline - Date.now()),
          destinationHeaders: target => { adultStreamUrl(target); return headersForDestination(policy, target); },
        });
        if (isHlsMedia(result.url, result.contentType)) return 'hls';
        if (/^(?:video|audio)\//i.test(result.contentType || '')) return 'file';
      } catch {
        // HEAD may be unsupported. GET reads headers only, never buffers a movie.
      }
    }
  } catch { /* A failed optional probe must not bypass checks or prevent existing playback. */ }
  finally { clearTimeout(timer); }
  return 'unknown';
}

module.exports = { isHlsMedia, probeAdultStreamFormat };
