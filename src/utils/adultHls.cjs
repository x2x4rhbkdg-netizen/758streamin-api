const { adultStreamUrl } = require('./adultStreamPolicy.cjs');

function rewriteAdultHls(text, base, wrap) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U') || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Invalid HLS playlist');
  const link = (value) => {
    const url = adultStreamUrl(new URL(value, base).href);
    return wrap(url.href);
  };
  const result = text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.trimStart().startsWith('#')) return link(line.trim());
    return line.replace(/\bURI="([^"\r\n]+)"/g, (_match, value) => `URI="${link(value)}"`);
  }).join('\n');
  if (Buffer.byteLength(result) > 8 * 1024 * 1024) throw new Error('HLS playlist exceeded its limit');
  return result;
}
module.exports = { rewriteAdultHls };
