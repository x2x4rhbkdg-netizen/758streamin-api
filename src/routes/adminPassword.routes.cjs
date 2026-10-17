const { Router } = require('express');
const bcrypt = require('bcryptjs');

function createAdminPasswordRouter({ db, authenticate, onError, now = Date.now }) {
  const router = Router();
  const attempts = new Map();
  router.post('/auth/password', authenticate, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = Number(req.admin?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(401).json({ error: 'Sign in to change your password.' });
    const { current_password: current, new_password: password } = req.body || {};
    if (typeof current !== 'string' || !current || Buffer.byteLength(current, 'utf8') > 1024 ||
        typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter your current password and a new password of at least 8 characters (maximum 72 UTF-8 bytes).' });
    }
    if (current === password) return res.status(400).json({ error: 'Choose a different new password.' });
    const time = now();
    for (const [key, value] of attempts) if (value.expires <= time) attempts.delete(key);
    const limit = attempts.get(id) || { count: 0, expires: time + 15 * 60 * 1000 };
    if (limit.count >= 5 || (!attempts.has(id) && attempts.size >= 10000)) {
      return res.status(429).json({ error: 'Too many password-change attempts. Try again in 15 minutes.' });
    }
    limit.count += 1;
    attempts.set(id, limit);
    try {
      const [rows] = await db.execute('SELECT password_hash, status FROM admins WHERE id=? LIMIT 1', [id]);
      const account = rows[0];
      if (!account || account.status !== 'active') return res.status(403).json({ error: 'Account unavailable.' });
      if (!await bcrypt.compare(current, account.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.' });
      const hash = await bcrypt.hash(password, 12);
      const [result] = await db.execute('UPDATE admins SET password_hash=?, updated_at=NOW() WHERE id=? AND password_hash=? AND status=?',
        [hash, id, account.password_hash, 'active']);
      if (result.affectedRows !== 1) return res.status(409).json({ error: 'Account changed. Sign in again and retry.' });
      return res.json({ ok: true });
    } catch (error) { return onError(req, res, 'admin/auth/password', error); }
  });
  return router;
}

module.exports = { createAdminPasswordRouter };
