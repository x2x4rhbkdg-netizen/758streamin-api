const crypto = require('node:crypto');
function createPlaybackTickets(secret) {
  if (!secret) throw new Error('Missing movie playback signing key');
  const key = crypto.createHmac('sha256', secret).update('streamin-movie-playback-v1').digest();
  return {
    issue(url, device, section, adultPinFingerprint) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      if (section === 'adult' && !adultPinFingerprint) throw new Error('Missing Adult PIN scope');
      const body = Buffer.from(JSON.stringify({ url, device: String(device), ...(['anime', 'adult'].includes(section) ? { section } : {}),
        ...(section === 'adult' ? { adultPinFingerprint, adultAgeConfirmed: true } : {}), expires: Date.now() + 6 * 60 * 60 * 1000 }));
      const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    read(ticket) {
      if (!/^[a-zA-Z0-9_-]{40,12000}$/.test(ticket || '')) throw new Error('Invalid playback ticket');
      const packed = Buffer.from(ticket, 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
      decipher.setAuthTag(packed.subarray(12, 28));
      const record = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString());
      if (!record.device || record.expires <= Date.now()) throw new Error('Expired playback ticket');
      return record;
    },
  };
}
module.exports = { createPlaybackTickets };
