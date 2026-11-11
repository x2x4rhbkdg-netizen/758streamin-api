const fs = require('node:fs');
const path = require('node:path');

function loadedRelease(filename = path.join(__dirname, '../../.deploy-release.json')) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')).id || null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function createHealthHandler({ pool, release = loadedRelease(), timeoutMs = 2000 }) {
  return async (_req, res) => {
    let timer;
    res.setHeader('Cache-Control', 'no-store');
    try {
      await Promise.race([
        pool.execute('SELECT 1'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs); }),
      ]);
      return res.json({ ok: true, service: '758streamin API', release });
    } catch {
      return res.status(503).json({ ok: false, service: '758streamin API', release });
    } finally { clearTimeout(timer); }
  };
}

module.exports = { createHealthHandler, loadedRelease };
