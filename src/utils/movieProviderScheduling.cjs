const crypto = require('node:crypto');
const accountKey = (provider, token) => crypto.createHash('sha256').update(`${provider}\n${token}`).digest('hex');

function createProviderScheduler({ now = Date.now, randomInt = crypto.randomInt } = {}) {
  const accounts = new Map();
  const record = (provider, settings) => {
    const key = accountKey(provider, settings.provider_accounts?.[provider]?.token || '');
    let value = accounts.get(key);
    if (!value || now() - value.started >= 3600000) {
      if (accounts.size >= 128) accounts.delete(accounts.keys().next().value);
      value = { attempts: 0, coolingUntil: 0, started: now() }; accounts.set(key, value);
    }
    return value;
  };
  return {
    order(providers, settings) {
      const ordered = [...providers];
      // Random ties prevent separate Passenger workers from all starting at the same provider.
      for (let index = ordered.length - 1; index > 0; index--) {
        const other = randomInt(index + 1);
        [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
      }
      return ordered.sort((a, b) => {
        const left = record(a, settings), right = record(b, settings);
        return Number(left.coolingUntil > now()) - Number(right.coolingUntil > now()) || left.attempts - right.attempts;
      });
    },
    reserve(provider, settings) { record(provider, settings).attempts++; },
    succeeded(provider, settings) { record(provider, settings).coolingUntil = 0; },
    failed(provider, settings, error) {
      if (error.status === 502 || !error.publicMessage) record(provider, settings).coolingUntil = now() + 30000;
    },
  };
}

function createAvailabilityCache({ now = Date.now } = {}) {
  const hashes = new Map(), errors = new Map();
  const read = (map, key) => {
    const value = map.get(key);
    if (!value || value.expires <= now()) { map.delete(key); return undefined; }
    return value.value;
  };
  const write = (map, key, value, ttl, limit) => {
    map.delete(key);
    if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, { value, expires: now() + ttl });
  };
  return {
    get(provider, token, hash) { return read(hashes, `${accountKey(provider, token)}:${hash.toLowerCase()}`); },
    put(provider, token, hash, ready) { write(hashes, `${accountKey(provider, token)}:${hash.toLowerCase()}`, ready, ready ? 60000 : 15000, 10000); },
    invalidate(provider, token, hash) { hashes.delete(`${accountKey(provider, token)}:${hash.toLowerCase()}`); },
    error(provider, token) { return read(errors, accountKey(provider, token)); },
    failed(provider, token, status) { write(errors, accountKey(provider, token), status, 10000, 128); },
  };
}

module.exports = { createProviderScheduler, createAvailabilityCache };
