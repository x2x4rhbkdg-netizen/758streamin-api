const HEADER_NAMES = new Set(['user-agent', 'referer', 'origin', 'accept', 'authorization', 'cookie']);

function adultStreamUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) || url.href.length > 4096) {
    throw new Error('Unsupported Adult stream URL');
  }
  return url;
}

function requestHeaders(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Adult stream headers');
  const result = {};
  for (const [name, content] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (!HEADER_NAMES.has(key) || Object.hasOwn(result, key) || typeof content !== 'string' ||
        !content || /[^\x20-\x7e]/.test(content) || content.length > 2048) throw new Error('Unsupported Adult stream headers');
    if (key === 'referer' || key === 'origin') adultStreamUrl(content);
    result[key] = content;
    if (Buffer.byteLength(JSON.stringify(result)) > 4096) throw new Error('Adult stream headers exceeded their limit');
  }
  return result;
}

function addonRequestHeaders(proxy = {}) {
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy) ||
      Object.keys(proxy).some(key => !['request', 'response'].includes(key)) ||
      (proxy.response && (typeof proxy.response !== 'object' || Array.isArray(proxy.response) || Object.keys(proxy.response).length))) {
    throw new Error('Unsupported Adult proxy headers');
  }
  // Response headers are deliberately not controlled by an add-on.
  return requestHeaders(proxy.request);
}

function adultRequestPolicy(url, headers) {
  const normalized = requestHeaders(headers);
  return Object.keys(normalized).length ? { origin: adultStreamUrl(url).origin, headers: normalized } : undefined;
}

function headersForDestination(policy, value) {
  if (!policy) return {};
  const origin = adultStreamUrl(policy.origin).origin;
  const headers = requestHeaders(policy.headers);
  // Do not leak add-on cookies, bearer tokens or referrers to a redirect/CDN origin.
  return adultStreamUrl(value).origin === origin ? headers : {};
}

module.exports = { adultStreamUrl, addonRequestHeaders, adultRequestPolicy, headersForDestination };
