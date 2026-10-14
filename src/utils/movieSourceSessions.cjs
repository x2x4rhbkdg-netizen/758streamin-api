const crypto = require('node:crypto');
function expired() { return Object.assign(new Error('Source search expired. Find sources again before playing.'), { status: 409 }); }
function createSourceCapabilities(secret) {
  if (!secret) throw new Error('Missing source signing key');
  const key = crypto.createHmac('sha256', secret).update('streamin-movie-source-v1').digest();
  const sign = (body) => crypto.createHmac('sha256', key).update(body).digest();
  function issueSource(deviceId, hash, metadata) {
    const body = Buffer.from(JSON.stringify({ device: String(deviceId), hash, metadata, expires: Date.now() + 3 * 60 * 60 * 1000 })).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  }
  function requireDiscoveredSource(deviceId, input) {
    const token = String(input?.source_token || '');
    if (token.length > 4096) throw expired();
    const parts = token.split('.');
    if (parts.length !== 2) throw expired();
    const signature = Buffer.from(parts[1], 'base64url');
    const expected = sign(parts[0]);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) throw expired();
    let record;
    try { record = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { throw expired(); }
    if (record.device !== String(deviceId) || record.expires <= Date.now() || record.hash !== String(input.hash).toLowerCase() ||
      record.metadata?.type !== input.type || (input.type === 'series' &&
      (record.metadata.season_int !== input.season_int || record.metadata.episode_int !== input.episode_int))) throw expired();
    return { ...record.metadata, hash: record.hash, provider: input.provider, allow_uncached_rd: input.allow_uncached_rd === true };
  }
  return { issueSource, requireDiscoveredSource };
}
module.exports = { createSourceCapabilities,
  issueSource: (...args) => createSourceCapabilities(process.env.JWT_SECRET).issueSource(...args),
  requireDiscoveredSource: (...args) => createSourceCapabilities(process.env.JWT_SECRET).requireDiscoveredSource(...args) };
