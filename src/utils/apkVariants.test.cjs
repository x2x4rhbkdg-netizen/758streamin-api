const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApkVariants, readApkVariants, selectApkVariant } = require('./apkVariants.cjs');
const row = { channel: 'direct', apk_url: 'https://example.com/universal.apk', sha256: 'u',
  apk_variants: JSON.stringify({ 'armeabi-v7a': { apk_url: 'https://example.com/arm32.apk' },
    x86_64: { apk_url: 'https://example.com/x64.apk' } }) };

test('selects only supported OS ABIs in device preference order, falling back to universal', () => {
  assert.equal(selectApkVariant(row, ['arm64-v8a', 'armeabi-v7a']).architecture, 'armeabi-v7a');
  assert.equal(selectApkVariant(row, ['x86_64', 'x86']).architecture, 'x86_64');
  assert.equal(selectApkVariant(row, ['x86']).apk_url, row.apk_url);
  assert.equal(selectApkVariant(row, ['armeabi-v7a']).sha256, null);
  assert.equal(selectApkVariant({ ...row, channel: 'amazon' }, ['armeabi-v7a']).apk_url, row.apk_url);
});
test('invalid stored metadata safely falls back without changing the universal URL', () => {
  for (const apk_variants of ['bad-json', '{"bad":{}}', '[]', null]) {
    assert.deepEqual(readApkVariants(apk_variants), {});
    assert.equal(selectApkVariant({ ...row, apk_variants }, ['x86_64']).apk_url, row.apk_url);
  }
});
test('normalizes hash case and rejects credentials, HTTP and unsupported keys', () => {
  assert.equal(normalizeApkVariants({ x86: { apk_url: 'https://example.com/a.apk', sha256: 'A'.repeat(64) } }).x86.sha256, 'a'.repeat(64));
  for (const apk_url of ['http://example.com/a.apk', 'https://user:pass@example.com/a.apk']) {
    assert.throws(() => normalizeApkVariants({ x86: { apk_url } }), /Invalid apk_variants/);
  }
});
