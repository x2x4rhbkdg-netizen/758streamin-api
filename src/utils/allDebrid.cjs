const { createHash } = require('node:crypto');
const magnets = new Map();
function failure(message, status = 409) { return Object.assign(new Error(message), { status, publicMessage: message }); }
function allDebridFailure(data) {
  const code = typeof data?.error?.code === 'string' ? data.error.code : '';
  const credentialRejected = /^AUTH_/.test(code);
  const rateLimited = ['RATE_LIMIT', 'RATE_LIMIT_REACHED', 'TOO_MANY_REQUESTS'].includes(code);
  const messages = {
    AUTH_BAD_APIKEY: 'AllDebrid rejected its API key. Update Media Settings.',
    AUTH_BLOCKED: 'AllDebrid requires account/IP verification. Check your AllDebrid account.',
    AUTH_USER_BANNED: 'AllDebrid reports that this account is banned.',
    NO_SERVER: 'AllDebrid rejected this server network. Check its VPN/IP policy or choose another provider.',
    MAGNET_NO_SERVER: 'AllDebrid rejected this server network. Check its VPN/IP policy or choose another provider.',
    MUST_BE_PREMIUM: 'AllDebrid requires an active premium account.',
    MAGNET_MUST_BE_PREMIUM: 'AllDebrid requires an active premium account.',
    MAGNET_TOO_MANY_ACTIVE: 'AllDebrid has too many active transfers. Complete or remove transfers in your account.',
    LINK_HOST_LIMIT_REACHED: 'AllDebrid host usage limit reached. Retry later or choose another provider.',
  };
  return Object.assign(failure(messages[code] || 'AllDebrid could not prepare this source. Retry or choose another provider.', 502), { credentialRejected, rateLimited });
}
function key(token, hash) { return createHash('sha256').update(`${token}\n${hash.toLowerCase()}`).digest('hex'); }
function knownId(token, hash) {
  const entry = magnets.get(key(token, hash));
  if (entry && entry.expires > Date.now()) return entry.id;
  magnets.delete(key(token, hash));
}
function remember(token, hash, id) {
  for (const [key, entry] of magnets) if (entry.expires <= Date.now()) magnets.delete(key);
  if (magnets.size >= 500) magnets.delete(magnets.keys().next().value);
  magnets.set(key(token, hash), { id, expires: Date.now() + 15 * 60 * 1000 });
}
function magnetList(data) {
  const value = data?.data?.magnets;
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && value.id != null) return [value];
  throw failure('AllDebrid returned an invalid transfer status', 502);
}
function readyHashes(token, hashes, data) {
  const ready = new Set(magnetList(data).filter(value => value.statusCode === 4).map(value => String(value.id)));
  return hashes.map(hash => { const id = knownId(token, hash); return id != null && ready.has(String(id)); });
}
function videoFiles(nodes, prefix = '', depth = 0, result = []) {
  if (!Array.isArray(nodes) || depth > 24) throw failure('AllDebrid returned an invalid file tree', 502);
  for (const node of nodes) {
    if (!node || typeof node.n !== 'string' || result.length >= 10000) throw failure('AllDebrid returned an invalid file tree', 502);
    const path = prefix ? `${prefix}/${node.n}` : node.n;
    if (Array.isArray(node.e)) videoFiles(node.e, path, depth + 1, result);
    else result.push({ path, bytes: node.s, link: node.l });
  }
  return result;
}
async function resolveAllDebrid({ token, input, call, signal, sleep, chooseVideo }) {
  let id = knownId(token, input.hash);
  if (id == null) {
    if (input.allow_uncached_ad !== true) throw failure('AllDebrid availability is unverified. Select this source to prepare it.');
    const data = await call('magnet/upload', { magnets: [`magnet:?xt=urn:btih:${input.hash.toLowerCase()}`] });
    const added = data?.data?.magnets?.[0];
    if (added?.error) throw allDebridFailure(added);
    if (!Number.isSafeInteger(added?.id) || added.id < 1 || String(added.hash).toLowerCase() !== input.hash.toLowerCase()) throw failure('AllDebrid returned an invalid selected transfer', 502);
    id = added.id; remember(token, input.hash, id);
  }
  let transfer;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (signal.aborted) throw failure('AllDebrid preparation timed out. Retry shortly.');
    const data = await call('../v4.1/magnet/status', { id });
    transfer = magnetList(data).find(value => String(value.id) === String(id));
    if (!transfer) { magnets.delete(key(token, input.hash)); throw failure('AllDebrid transfer is no longer available. Select the source again.'); }
    if (transfer.statusCode === 4) break;
    if (Number.isInteger(transfer.statusCode) && transfer.statusCode >= 5) {
      magnets.delete(key(token, input.hash)); throw failure('AllDebrid could not download this source. Choose another source.');
    }
    if (attempt < 7) await sleep(750, signal);
  }
  if (transfer?.statusCode !== 4) throw failure('AllDebrid is preparing this source. Retry shortly.');
  const file = chooseVideo(videoFiles(transfer.files), input);
  let link;
  try { link = new URL(file.link); } catch { throw failure('AllDebrid did not return a matching file link', 502); }
  if (link.protocol !== 'https:' || link.username || link.password) throw failure('AllDebrid returned an unsupported file link', 502);
  return (await call('link/unlock', { link: link.href }))?.data?.link;
}
module.exports = { allDebridFailure, readyHashes, resolveAllDebrid };
