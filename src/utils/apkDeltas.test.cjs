const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApkDeltas, readApkDeltas, selectApkDelta } = require('./apkDeltas.cjs');
const base = 'a'.repeat(64), target = 'b'.repeat(64);
const patch = { format: 'bsdiff43-gzip-v1', architecture: 'universal', from_version_code: 99,
  from_sha256: base, to_sha256: target, patch_sha256: 'c'.repeat(64),
  patch_url: 'https://updates.example/99-100.patch.gz', patch_size: 100, to_size: 1000 };
const row = { channel: 'direct', version_code: 100, apk_url: 'https://updates.example/app-tv-release.apk', sha256: target, delta_patches: [patch] };
const request = { version_code: 99, installed_sha256: base, delta_formats: [patch.format], supported_abis: ['arm64-v8a'] };

test('universal users can keep a universal delta even when a smaller ABI full APK exists', () => {
  const variants = { 'arm64-v8a': { apk_url: 'https://updates.example/arm.apk', sha256: 'd'.repeat(64) } };
  const selected = selectApkDelta(row, request, variants);
  assert.equal(selected.architecture, 'universal'); assert.equal(selected.apk_url, row.apk_url);
  assert.equal(selected.delta.from_sha256, base);
});
test('patches require exact base version, hash, format, target hash, ABI and direct channel', () => {
  for (const change of [{ version_code: 98 }, { installed_sha256: 'd'.repeat(64) }, { delta_formats: [] }, { installed_sha256: undefined }]) {
    assert.equal(selectApkDelta(row, { ...request, ...change }, {}), null);
  }
  for (const change of [{ channel: 'play' }, { channel: 'amazon' }, { sha256: 'd'.repeat(64) }, { version_code: 99 }]) {
    assert.equal(selectApkDelta({ ...row, ...change }, request, {}), null);
  }
  const arm = { ...patch, architecture: 'arm64-v8a' };
  assert.equal(selectApkDelta({ ...row, delta_patches: [arm] }, { ...request, supported_abis: ['armeabi-v7a'] }, { 'arm64-v8a': { sha256: target } }), null);
});
test('malformed and oversized patch records fail closed; saved invalid metadata preserves full fallback', () => {
  for (const change of [{ patch_url: 'http://updates.example/p' }, { patch_url: 'https://user:pass@updates.example/p' },
    { patch_size: 800 }, { to_size: 2 ** 40 }, { from_sha256: 'bad' }, { format: 'unknown' }, { architecture: 'bad' }]) {
    assert.throws(() => normalizeApkDeltas([{ ...patch, ...change }]));
    assert.deepEqual(readApkDeltas([{ ...patch, ...change }]), []);
  }
  assert.throws(() => normalizeApkDeltas([patch, patch]));
  assert.deepEqual(readApkDeltas(null), []);
});
