const crypto = require('node:crypto');
const denied = () => Object.assign(new Error('Unlock Adult Content again'), { status: 403 });

function createAdultTokens(secret, now = Date.now) {
  if (!secret) throw new Error('Missing Adult signing key');
  const key = crypto.createHmac('sha256', secret).update('streamin-adult-v1').digest();
  return {
    issue(purpose, device, data, ttl = 15 * 60 * 1000) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(JSON.stringify({ purpose, device: String(device), data, expires: now() + ttl })), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
    },
    read(token, purpose, device) {
      try {
        if (!/^[a-zA-Z0-9_-]{40,16000}$/.test(token || '')) throw denied();
        const bytes = Buffer.from(token, 'base64url');
        if (bytes.toString('base64url') !== token) throw denied();
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
        if (value.purpose !== purpose || value.device !== String(device) || value.expires <= now()) throw denied();
        return value.data;
      } catch { throw denied(); }
    },
  };
}

async function readAdultPin(device) {
  const { pool } = require('../db/pool.cjs');
  const { decryptString } = require('./cryptoVault.cjs');
  const [rows] = await pool.execute('SELECT adult_pin_enc FROM device_access WHERE device_id=? LIMIT 1', [device]);
  const encrypted = rows[0]?.adult_pin_enc;
  if (!encrypted) return null;
  return { pin: decryptString(encrypted), fingerprint: crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('adult-pin-v1:').update(encrypted).digest('hex') };
}
module.exports = { createAdultTokens, readAdultPin };
