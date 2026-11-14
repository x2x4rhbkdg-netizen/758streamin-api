const { Router } = require('express');
const https = require('node:https');
const http = require('node:http');
const dns = require('node:dns/promises');
const { pipeline } = require('node:stream/promises');
const { publicAddress } = require('../utils/scraperHttp.cjs');
const { createPinnedLookup } = require('../utils/pinnedLookup.cjs');
const { createPlaybackTickets, playbackTicketValue } = require('../utils/moviePlaybackTickets.cjs');
const { isHlsMedia } = require('../utils/adultStreamFormat.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { requireCatalogAccess } = require('../utils/animeCatalog.cjs');
const { readAdultPin } = require('../utils/adultAccess.cjs');
const { rewriteAdultHls } = require('../utils/adultHls.cjs');
const { adultStreamUrl, headersForDestination } = require('../utils/adultStreamPolicy.cjs');
const { playbackLogging } = require('../utils/playbackLogging.cjs');
const { createHlsUpstreamDiagnostics } = require('../utils/hlsUpstreamDiagnostics.cjs');
const diagnostics = createHlsUpstreamDiagnostics({ movieStream: true });
const router = Router();
router.use(playbackLogging.middleware);
let active = 0;

async function openStream(value, method, headers, signal, redirects = 0, adult = false, requestPolicy) {
  playbackLogging.stage('destination_validation');
  playbackLogging.target(value);
  const url = adult ? adultStreamUrl(value) : new URL(value);
  if (!adult && (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))) throw new Error('Invalid stream URL');
  playbackLogging.stage('dns');
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  playbackLogging.stage('destination_validation');
  if (signal.aborted || !addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Invalid stream destination');
  return new Promise((resolve, reject) => {
    playbackLogging.stage('request_headers');
    const scopedHeaders = adult ? headersForDestination(requestPolicy, url.href) : {};
    playbackLogging.stage('connect');
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, headers: { ...scopedHeaders, ...headers, 'Accept-Encoding': 'identity' }, signal, autoSelectFamily: true,
      lookup: createPinnedLookup(addresses),
    }, (response) => {
      playbackLogging.stage('upstream_headers');
      const type = String(response.headers['content-type'] || '').toLowerCase();
      const responseKind = /mpegurl|m3u8/.test(type) ? 'hls' : type.startsWith('video/') ? 'video' :
        type.startsWith('audio/') ? 'audio' : type.includes('html') ? 'html' : type.includes('json') ? 'json' :
        type.includes('octet-stream') ? 'binary' : 'other';
      playbackLogging.debug('stream_response', { status: response.statusCode, responseKind,
        rangeRequested: Boolean(headers.Range), headersApplied: Object.keys(scopedHeaders).length > 0, redirects });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        playbackLogging.stage('redirect');
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error('Invalid stream redirect'));
        resolve(openStream(new URL(response.headers.location, url).href, method, headers, signal, redirects + 1, adult, requestPolicy));
      } else { response.streaminUrl = url.href; resolve(response); }
    });
    request.setTimeout(30000, () => request.destroy(Object.assign(new Error('Stream timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end();
  });
}

router.get('/movies/stream/:ticket', async (req, res) => {
  const startedAt = diagnostics.now();
  playbackLogging.stage('ticket_validation');
  res.set('Cache-Control', 'private, no-store');
  let record;
  try { record = createPlaybackTickets(process.env.JWT_SECRET).read(req.params.ticket); }
  catch { return res.status(403).json({ error: 'Playback link expired. Open this source again.' }); }
  if (active >= 16) return res.status(429).json({ error: 'Movie streaming is busy' });
  const range = req.get('range');
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return res.sendStatus(416);
  active++;
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  const timer = setTimeout(abort, 30000);
  let upstream;
  try {
    playbackLogging.stage('authorization');
    try {
      requireCatalogAccess(await readMovieSettings(record.device), record.section);
      if (record.section === 'adult') {
        if (record.adultAgeConfirmed !== true) return res.sendStatus(403);
        const pin = await readAdultPin(record.device);
        if (!pin || pin.fingerprint !== record.adultPinFingerprint) return res.sendStatus(403);
      }
    }
    catch (error) { if (error.status === 403) return res.sendStatus(403); throw error; }
    playbackLogging.identify({ type: record.section === 'adult' ? 'adult' : record.section === 'anime' ? 'anime' : 'vod' }, {}, playbackTicketValue(req.params.ticket));
    upstream = await openStream(record.url, req.method === 'HEAD' ? 'HEAD' : 'GET', range ? { Range: range } : {}, controller.signal,
      0, record.section === 'adult', record.requestPolicy);
    clearTimeout(timer);
    if (![200, 206, 416].includes(upstream.statusCode)) {
      diagnostics.failure({ status: upstream.statusCode }, { startedAt, targetUrl: upstream.streaminUrl || record.url, timeoutMs: 30000 });
      upstream.destroy(); return res.sendStatus(502);
    }
    const isAdultHls = record.section === 'adult' && isHlsMedia(upstream.streaminUrl || record.url, upstream.headers['content-type']);
    if (isAdultHls) {
      playbackLogging.stage('manifest_rewrite');
      if (req.method === 'HEAD') { upstream.resume(); return res.status(200).set('Content-Type', 'application/vnd.apple.mpegurl').end(); }
      const chunks = []; let length = 0;
      for await (const chunk of upstream) {
        length += Buffer.byteLength(chunk);
        if (length > 1024 * 1024) throw new Error('HLS playlist exceeded its limit');
        chunks.push(Buffer.from(chunk));
      }
      const base = new URL(process.env.MOVIE_PLAYBACK_BASE_URL || 'https://api.758streamin.com');
      if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid playback base URL');
      const rewritten = rewriteAdultHls(Buffer.concat(chunks).toString('utf8'), upstream.streaminUrl || record.url, (url, playlist) => {
        const ticket = createPlaybackTickets(process.env.JWT_SECRET).issue(url, record.device, 'adult', record.adultPinFingerprint, record.requestPolicy);
        return new URL(`/v1/movies/stream/${ticket}${playlist ? '.m3u8' : ''}`, base).href;
      });
      return res.status(200).set('Content-Type', 'application/vnd.apple.mpegurl').end(rewritten);
    }
    res.status(upstream.statusCode);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[header]) res.set(header, upstream.headers[header]);
    }
    // Pipe with backpressure; never buffer a movie or expose upstream redirects/credentials.
    playbackLogging.stage('body_transfer');
    await pipeline(upstream, res);
  } catch (error) {
    diagnostics.failure(error, { startedAt, targetUrl: upstream?.streaminUrl, timeoutMs: 30000,
      timedOut: controller.signal.aborted && !res.destroyed });
    upstream?.destroy();
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Movie stream temporarily unavailable' });
    else res.destroy();
  } finally { clearTimeout(timer); res.off('close', abort); active--; }
});
module.exports = router;
