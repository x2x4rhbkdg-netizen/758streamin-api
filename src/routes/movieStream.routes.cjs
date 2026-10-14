const { Router } = require('express');
const https = require('node:https');
const dns = require('node:dns/promises');
const { pipeline } = require('node:stream/promises');
const { publicAddress } = require('../utils/scraperHttp.cjs');
const { createPlaybackTickets } = require('../utils/moviePlaybackTickets.cjs');
const { readMovieSettings } = require('../utils/movieSettings.cjs');
const { requireCatalogAccess } = require('../utils/animeCatalog.cjs');
const router = Router();
let active = 0;

async function openStream(value, method, headers, signal, redirects = 0) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Invalid stream URL');
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (signal.aborted || !addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Invalid stream destination');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, signal,
      lookup: (_host, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error('Invalid stream redirect'));
        resolve(openStream(new URL(response.headers.location, url).href, method, headers, signal, redirects + 1));
      } else resolve(response);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Stream timed out')));
    request.on('error', reject);
    request.end();
  });
}

router.get('/movies/stream/:ticket', async (req, res) => {
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
    try { requireCatalogAccess(await readMovieSettings(record.device), record.section); }
    catch (error) { if (error.status === 403) return res.sendStatus(403); throw error; }
    upstream = await openStream(record.url, req.method === 'HEAD' ? 'HEAD' : 'GET', range ? { Range: range } : {}, controller.signal);
    clearTimeout(timer);
    if (![200, 206, 416].includes(upstream.statusCode)) { upstream.destroy(); return res.sendStatus(502); }
    res.status(upstream.statusCode);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[header]) res.set(header, upstream.headers[header]);
    }
    // Pipe with backpressure; never buffer a movie or expose upstream redirects/credentials.
    await pipeline(upstream, res);
  } catch {
    upstream?.destroy();
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Movie stream temporarily unavailable' });
    else res.destroy();
  } finally { clearTimeout(timer); res.off('close', abort); active--; }
});
module.exports = router;
