const crypto = require('node:crypto');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const NORMAL_SECTIONS = ['movies', 'series', 'anime'];

function normalizeProgress(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || !Number.isFinite(input.position) || input.position < 0 ||
    !Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 864000 ||
    !Number.isFinite(input.updatedAt) || input.updatedAt < 0) throw fail('Invalid history progress');
  return { position: Math.min(input.duration, input.position), duration: input.duration, updatedAt: Math.min(now, input.updatedAt) };
}
function normalizeHistory(input, now = Date.now()) {
  const section = input?.section === 'anime' ? 'anime' : input?.type === 'series' ? 'series' : 'movies';
  if (input?.section && input.section !== 'anime' || !['movie', 'series'].includes(input?.type) ||
    typeof input.id !== 'string' || !/^(?:\d+|kitsu:\d+)$/.test(input.id) ||
    typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) throw fail('Invalid history entry');
  const entry = { id: input.id, type: input.type, title: input.title, ...normalizeProgress(input, now) };
  if (section === 'anime') entry.section = 'anime';
  if (section === 'anime' && ['dub', 'all'].includes(input.sourceLanguage)) entry.sourceLanguage = input.sourceLanguage;
  if (input.type === 'series') {
    if (!Number.isInteger(input.season) || input.season < 0 || input.season > 10000 ||
      !Number.isInteger(input.episode) || input.episode < 0 || input.episode > 100000) throw fail('Invalid history episode');
    entry.season = input.season; entry.episode = input.episode;
  }
  if (typeof input.poster === 'string' && input.poster.length <= 4096 && /^https:\/\//i.test(input.poster)) entry.poster = input.poster;
  if (typeof input.year === 'string' && input.year.length <= 12) entry.year = input.year;
  if (typeof input.videoId === 'string' && input.videoId.length <= 300) entry.videoId = input.videoId;
  return { section, entry, key: hash(`${entry.type}:${entry.id}:${entry.season ?? ''}:${entry.episode ?? ''}`) };
}
function createMediaHistoryStore({ db, encrypt, decrypt } = {}) {
  const pool = () => db || require('../db/pool.cjs').pool;
  const seal = value => (encrypt || require('./cryptoVault.cjs').encryptString)(JSON.stringify(value));
  const open = value => JSON.parse((decrypt || require('./cryptoVault.cjs').decryptString)(value));
  return {
    async owner(device) {
      const [rows] = await pool().execute('SELECT id, whmcs_client_id FROM devices WHERE id=? LIMIT 1', [device]);
      if (!rows[0]) throw fail('Device not found', 401);
      const client = Number(rows[0].whmcs_client_id);
      return hash(Number.isSafeInteger(client) && client > 0 ? `whmcs-client:${client}` : `device:${rows[0].id}`);
    },
    async list(owner, sections = NORMAL_SECTIONS) {
      if (!sections.length || sections.some(section => ![...NORMAL_SECTIONS, 'adult'].includes(section))) throw fail('Invalid history section');
      const [rows] = await pool().execute(`SELECT entry_enc FROM media_history WHERE owner_key=? AND section IN (${sections.map(() => '?').join(',')}) ORDER BY progress_updated_at DESC LIMIT 1000`, [owner, ...sections]);
      return rows.flatMap(row => { try { return [open(row.entry_enc)]; } catch { return []; } });
    },
    async put(owner, section, key, entry) {
      await pool().execute(`INSERT INTO media_history (owner_key, section, entry_key, entry_enc, progress_updated_at)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
        entry_enc=IF(VALUES(progress_updated_at)>=progress_updated_at, VALUES(entry_enc), entry_enc),
        saved_at=IF(VALUES(progress_updated_at)>=progress_updated_at, NOW(), saved_at),
        progress_updated_at=GREATEST(progress_updated_at, VALUES(progress_updated_at))`,
      [owner, section, key, seal(entry), entry.updatedAt]);
    },
  };
}
module.exports = { createMediaHistoryStore, normalizeHistory, normalizeProgress, NORMAL_SECTIONS, hash };
