const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { publicAddress } = require('./scraperHttp.cjs');
const { createPinnedLookup } = require('./pinnedLookup.cjs');
// Isolated pools contain only sockets opened through the validated lookup below.
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function failure(message, status = 403) {
  return Object.assign(new Error(message), { status });
}

function publicAssetAddress(address) {
  if (net.isIP(address) !== 6) return publicAddress(address);
  // Canonicalize expanded IPv6 before applying the shared special-range policy.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return publicAddress(normalized) && !/^3fff:/i.test(normalized);
}

function assetUrl(value, allowedOrigins) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid playback asset destination'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      String(value).length > 16384 ||
      (allowedOrigins && !allowedOrigins.includes(url.origin))) {
    throw failure('playback asset destination not allowed');
  }
  return url;
}

function legacyAssetOrigins(upstreamBase, configured = process.env.PLAYBACK_ASSET_ALLOWED_ORIGINS || '') {
  return [...new Set([upstreamBase, ...String(configured).split(',')].filter(Boolean).map(value => assetUrl(String(value).trim()).origin))];
}

function createPlaybackAssetReader({ lookup = dns.lookup, requestHttp = http.get, requestHttps = https.get } = {}) {
  return async function readAsset(value, init = {}, options = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signal = init.signal;
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
    const maxBytes = Math.max(1, Math.min(512 * 1024 * 1024, Number(options.maxBytes) || 64 * 1024 * 1024));
    const timer = setTimeout(abort, timeoutMs);
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(failure('playback asset request aborted', 504)); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    // Observe early aborts even before the first DNS/request race is installed.
    aborted.catch(() => {});
    if (controller.signal.aborted) rejectAbort();

    async function visit(target, redirects = 0) {
      const url = assetUrl(target, options.allowedOrigins);
      try { options.onDestination?.(url.href); } catch { /* Diagnostics are non-fatal. */ }
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const literalFamily = net.isIP(hostname);
      const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] :
        await Promise.race([lookup(hostname, { all: true }), aborted]);
      if (!addresses.length || addresses.some(({ address }) => !publicAssetAddress(address))) {
        throw failure('private playback asset destination blocked');
      }
      if (controller.signal.aborted) throw failure('playback asset request aborted', 504);
      return Promise.race([aborted, new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
          signal: controller.signal,
          autoSelectFamily: true,
          agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
          headers: { ...init.headers, 'Accept-Encoding': 'identity' },
          // Pin only checked addresses, retaining dual-stack connection fallback.
          lookup: createPinnedLookup(addresses),
        }, response => {
          const status = Number(response.statusCode);
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.destroy();
            if (redirects >= 5 || !location) return reject(failure('invalid playback asset redirect', 502));
            let next;
            try { next = new URL(location, url).href; } catch { return reject(failure('invalid playback asset redirect', 502)); }
            resolve(visit(next, redirects + 1));
            return;
          }
          if (status < 200 || status >= 300) {
            response.destroy(); reject(failure('upstream failed', status || 502)); return;
          }
          if (Number(response.headers['content-length']) > maxBytes) {
            response.destroy(); reject(failure('playback asset response too large', 502)); return;
          }
          const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
          const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
          if (!decoder && encoding !== 'identity') {
            response.destroy(); reject(failure('unsupported playback asset encoding', 502)); return;
          }
          const stop = error => { response.destroy(); decoder?.destroy(); request.destroy(); reject(error); };
          let received = 0, decoded = 0;
          response.on('error', error => { decoder?.destroy(); reject(error); });
          response.on('aborted', () => stop(failure('incomplete playback asset response', 502)));
          response.on('data', chunk => {
            received += chunk.length;
            if (received > maxBytes) stop(failure('playback asset response too large', 502));
          });
          const body = decoder ? response.pipe(decoder) : response;
          const chunks = [];
          body.on('error', stop);
          body.on('data', chunk => {
            decoded += chunk.length;
            if (decoded > maxBytes) { stop(failure('playback asset response too large', 502)); return; }
            chunks.push(chunk);
          });
          body.on('end', () => resolve({
            buffer: Buffer.concat(chunks), url: url.href, status,
            contentType: String(response.headers['content-type'] || ''),
            contentLength: decoder ? '' : String(response.headers['content-length'] || ''),
            contentRange: String(response.headers['content-range'] || ''),
            acceptRanges: String(response.headers['accept-ranges'] || ''),
          }));
        });
        request.on('error', reject);
      })]);
    }
    try { return await visit(value); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  };
}

module.exports = { createPlaybackAssetReader, legacyAssetOrigins, assetUrl };
