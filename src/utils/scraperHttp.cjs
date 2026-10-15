const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6) return false;
  // Only global unicast; exclude special-purpose and transition prefixes.
  return /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0*:|db8:|2:|10:|20:)/i.test(address) && !/^2002:/i.test(address);
}

function validateUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || String(value).length > 4096) {
    throw new Error('Unsafe scraper URL');
  }
  return url;
}

async function readText(value, { signal, redirects = 0, accept = 'application/json,text/html' } = {}) {
  const url = validateUrl(value);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 4000);
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise((_, reject) => {
        if (controller.signal.aborted) return reject(new Error('Scraper timed out'));
        controller.signal.addEventListener('abort', () => reject(new Error('Scraper timed out')), { once: true });
      }),
    ]);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Private scraper destination blocked');
    const selected = addresses[0];
    return await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'StreamIN-Scraper/1.0', Accept: accept, 'Accept-Encoding': 'identity' },
        // Pin the validated DNS result to prevent rebinding between lookup and connection.
        lookup: (_host, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects >= 3 || !response.headers.location) return reject(new Error('Invalid scraper redirect'));
          resolve(readText(new URL(response.headers.location, url).href, { signal: controller.signal, redirects: redirects + 1, accept }));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume(); reject(new Error('Scraper HTTP error')); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.resume(); reject(new Error('Unsupported scraper encoding')); return;
        }
        let bytes = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { request.destroy(new Error('Scraper response too large')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { readText, publicAddress, validateUrl };
