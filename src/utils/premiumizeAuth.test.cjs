const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPremiumizeAuth } = require('./premiumizeAuth.cjs');
const key = crypto.randomBytes(32);
const encrypt = (text) => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
};
const decrypt = (text) => {
  const bytes = Buffer.from(text, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
};
test('Premiumize authorization hides secrets, respects pending/slow-down and saves only the approved account', async () => {
  let status = 'authorization_pending', saved;
  const auth = createPremiumizeAuth({ clientId: 'test-client', encrypt, decrypt, save: async (value) => { saved = value; },
    request: async (params) => params.response_type ? { verification_uri: 'https://www.premiumize.me/device', user_code: 'ABCD', device_code: 'private-device-code', interval: 5, expires_in: 600 }
      : status ? { error: status } : { access_token: 'private-access-token' } });
  const flow = await auth.start(1);
  assert.equal(JSON.stringify(flow).includes('private-device-code'), false);
  await assert.rejects(auth.poll(2, flow.state), { status: 409 });
  assert.equal((await auth.poll(1, flow.state)).status, 'pending');
  assert.equal(saved, undefined);
  status = 'slow_down'; assert.equal((await auth.poll(1, flow.state)).interval, 10);
  status = null; const result = await auth.poll(1, flow.state);
  assert.deepEqual(saved, { provider_accounts: { Premiumize: { enabled: true, token: 'private-access-token' } } });
  assert.deepEqual(result, { status: 'connected' });
});
test('Premiumize needs a registered client, rejects expired or altered states and foreign approval URLs', async () => {
  const options = { encrypt, decrypt, save: async () => { throw new Error('Unexpected save'); } };
  await assert.rejects(createPremiumizeAuth(options).start(1), { status: 503 });
  const auth = createPremiumizeAuth({ ...options, clientId: 'client', request: async () => ({ device_code: 'code', user_code: 'ABCD', verification_uri: 'https://evil.example/device' }) });
  await assert.rejects(auth.start(1));
  await assert.rejects(auth.poll(1, 'tampered'), { status: 409 });
  await assert.rejects(auth.poll(1, encrypt(JSON.stringify({ purpose: 'premiumize-oauth', admin: '1', clientId: 'client', expires: Date.now() - 1 }))), { status: 409 });
});
