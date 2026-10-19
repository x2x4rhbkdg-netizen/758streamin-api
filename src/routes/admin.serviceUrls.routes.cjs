const express = require('express');

function serviceOrigin(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    return url.origin;
  } catch { return null; }
}
const superAdmin = role => ['super_admin', 'superadmin'].includes(String(role || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));

function createServiceUrlsRouter({ db, authenticate, defaultUrl, onError }) {
  const router = express.Router();
  router.use('/service-urls', authenticate, (req, res, next) => req.method === 'GET' || superAdmin(req.admin?.role)
    ? next() : res.status(403).json({ error: 'Super admin access required.' }));
  const error = (req, res, failure) => {
    if (failure.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Run migrate.service-urls.mysql.sql before using the service directory.' });
    if (failure.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This service URL is already in the directory.' });
    return onError(req, res, 'admin/service-urls', failure);
  };
  router.get('/service-urls', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 100);
      const selected = serviceOrigin(req.query.current_url);
      const fallback = serviceOrigin(defaultUrl);
      // Escape LIKE wildcards so autocomplete treats the search as literal text.
      const pattern = `%${q.replace(/[!%_]/g, '!$&')}%`;
      const [services] = await db.execute(`SELECT id, name, url FROM service_urls
        WHERE name LIKE ? ESCAPE '!' OR url LIKE ? ESCAPE '!' ORDER BY name, id LIMIT 50`, [pattern, pattern]);
      const [matches] = await db.execute('SELECT id, name, url FROM service_urls WHERE url IN (?, ?)', [selected || '', fallback || '']);
      res.json({ services, selected_service: matches.find(row => row.url === selected) || null,
        default_service: fallback ? matches.find(row => row.url === fallback) || { id: 'default', name: 'Default Service', url: fallback } : null });
    } catch (failure) { return error(req, res, failure); }
  });
  const save = async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const url = serviceOrigin(req.body?.url);
    if (req.params.id && (!Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: 'Invalid service ID.' });
    if (!name || name.length > 120 || !url) return res.status(400).json({ error: 'Enter a name (up to 120 characters) and an HTTP(S) host with optional port, without a path or credentials.' });
    try {
      if (id) {
        const [rows] = await db.execute('SELECT id FROM service_urls WHERE id=?', [id]);
        if (!rows.length) return res.status(404).json({ error: 'Service not found.' });
        await db.execute('UPDATE service_urls SET name=?, url=?, updated_at=NOW() WHERE id=?', [name, url, id]);
      } else {
        const [result] = await db.execute('INSERT INTO service_urls (name, url) VALUES (?, ?)', [name, url]);
        return res.status(201).json({ id: result.insertId, name, url });
      }
      return res.json({ id, name, url });
    } catch (failure) { return error(req, res, failure); }
  };
  router.post('/service-urls', save);
  router.patch('/service-urls/:id', save);
  router.delete('/service-urls/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid service ID.' });
    try {
      const [result] = await db.execute('DELETE FROM service_urls WHERE id=?', [id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'Service not found.' });
      return res.json({ ok: true });
    } catch (failure) { return error(req, res, failure); }
  });
  return router;
}
module.exports = { createServiceUrlsRouter, serviceOrigin };
