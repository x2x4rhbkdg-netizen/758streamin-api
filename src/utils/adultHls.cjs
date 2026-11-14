const { adultStreamUrl } = require('./adultStreamPolicy.cjs');
const { isHlsMedia } = require('./adultStreamFormat.cjs');

function rewriteAdultHls(text, base, wrap) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U') || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Invalid HLS playlist');
  const link = (value, playlist = false) => {
    const url = adultStreamUrl(new URL(value, base).href);
    return wrap(url.href, playlist || isHlsMedia(url.href));
  };
  let nextPlaylist = false;
  const result = text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.trimStart().startsWith('#')) {
      const playlist = nextPlaylist; nextPlaylist = false;
      return link(line.trim(), playlist);
    }
    if (/^\s*#EXT-X-STREAM-INF:/.test(line)) nextPlaylist = true;
    const playlist = /^\s*#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT):/.test(line);
    return line.replace(/\bURI="([^"\r\n]+)"/g, (_match, value) => `URI="${link(value, playlist)}"`);
  }).join('\n');
  if (Buffer.byteLength(result) > 8 * 1024 * 1024) throw new Error('HLS playlist exceeded its limit');
  return result;
}
module.exports = { rewriteAdultHls };
