function authError(message, status = 502) { return Object.assign(new Error(message), { status }); }
async function requestToken(parameters) {
  const response = await fetch('https://www.premiumize.me/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString(),
  });
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 65536) throw authError('Premiumize authentication response exceeded its limit');
    chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(Buffer.concat(chunks).toString());
  if (!response.ok && !data.error) throw authError('Premiumize authentication unavailable');
  return data;
}
function createPremiumizeAuth({ clientId, encrypt, decrypt, save, request = requestToken }) {
  function configured() {
    if (!clientId) throw authError('Set PREMIUMIZE_CLIENT_ID on the API using your registered StreamIN OAuth client.', 503);
  }
  return {
    async start(admin) {
      configured();
      const data = await request({ client_id: clientId, response_type: 'device_code' });
      const uri = new URL(data.verification_uri);
      if (data.error || typeof data.device_code !== 'string' || !data.user_code || uri.protocol !== 'https:' || uri.hostname !== 'www.premiumize.me') throw authError('Premiumize did not return a valid authorization code');
      const expires = Math.min(900, Math.max(1, Number(data.expires_in) || 600));
      const interval = Math.min(60, Math.max(5, Number(data.interval) || 5));
      return { user_code: data.user_code, verification_uri: uri.href, expires_in: expires, interval,
        state: encrypt(JSON.stringify({ purpose: 'premiumize-oauth', admin: String(admin), clientId,
          device_code: data.device_code, expires: Date.now() + expires * 1000 })) };
    },
    async poll(admin, state) {
      configured();
      let record;
      try {
        if (typeof state !== 'string' || state.length > 12000) throw new Error();
        record = JSON.parse(decrypt(state));
        if (record.purpose !== 'premiumize-oauth' || record.admin !== String(admin) || record.clientId !== clientId || record.expires <= Date.now()) throw new Error();
      } catch { throw authError('Authentication expired. Start again.', 409); }
      const data = await request({ client_id: clientId, grant_type: 'device_code', code: record.device_code });
      if (data.error === 'authorization_pending') return { status: 'pending' };
      if (data.error === 'slow_down') return { status: 'pending', interval: 10 };
      if (data.error || typeof data.access_token !== 'string' || !data.access_token) throw authError('Premiumize authorization was declined or expired. Start again.', 409);
      await save({ provider_accounts: { Premiumize: { enabled: true, token: data.access_token } } });
      return { status: 'connected' };
    },
  };
}
module.exports = { createPremiumizeAuth };
