const { createMediaHistoryStore, hash } = require('./mediaHistory.cjs');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function normalizeLiveFavorite(input, now = Date.now()) {
  if (!input || typeof input.stream_id !== 'string' || !/^[1-9]\d{0,19}$/.test(input.stream_id) ||
      typeof input.favorite !== 'boolean' || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) throw fail('Invalid channel favourite');
  return { stream_id: input.stream_id, favorite: input.favorite, updatedAt: Math.min(now, input.updatedAt) };
}
function createLiveFavoritesStore({ db, encrypt, decrypt, getUpstream = device => require('./upstreamAuth.cjs').getDeviceUpstream(device) } = {}) {
  const history = createMediaHistoryStore({ db, encrypt, decrypt });
  return {
    async owner(device) {
      const account = await history.owner(device);
      const upstream = await getUpstream(device);
      if (!upstream) throw fail('Live TV account is not configured', 503);
      return hash(JSON.stringify(['live-favorites', account, String(upstream.upstream_base_url).trim().replace(/\/+$/, ''), upstream.username]));
    },
    async list(owner) {
      const pool = db || require('../db/pool.cjs').pool;
      const [rows] = await pool.execute("SELECT entry_enc FROM media_history WHERE owner_key=? AND section='live' ORDER BY progress_updated_at DESC LIMIT 5000", [owner]);
      const open = decrypt || require('./cryptoVault.cjs').decryptString;
      return rows.flatMap(row => { try { return [normalizeLiveFavorite(JSON.parse(open(row.entry_enc)))]; } catch { return []; } });
    },
    put: (owner, entry) => history.put(owner, 'live', hash(entry.stream_id), entry),
  };
}
module.exports = { normalizeLiveFavorite, createLiveFavoritesStore };
