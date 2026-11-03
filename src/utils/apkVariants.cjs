const APK_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const invalid = () => Object.assign(new Error('Invalid apk_variants: use supported ABI names, HTTPS APK URLs and optional 64-character SHA256 hashes.'), { status: 400 });

function normalizeApkVariants(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result = {};
  for (const [abi, variant] of Object.entries(value)) {
    if (!APK_ABIS.includes(abi) || !variant || typeof variant !== 'object' || Array.isArray(variant)) throw invalid();
    const url = variant.apk_url;
    const sha = variant.sha256 == null ? null : String(variant.sha256).trim().toLowerCase() || null;
    if (typeof url !== 'string' || url.length > 2000 || sha && !/^[a-f0-9]{64}$/.test(sha)) throw invalid();
    let parsed;
    try { parsed = new URL(url.trim()); } catch { throw invalid(); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw invalid();
    result[abi] = { apk_url: url.trim(), sha256: sha };
  }
  return result;
}

function readApkVariants(value) {
  try { return normalizeApkVariants(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return {}; }
}

function selectApkVariant(row, supportedAbis) {
  const variants = row.channel === 'direct' ? readApkVariants(row.apk_variants) : {};
  const abis = Array.isArray(supportedAbis) ? supportedAbis.slice(0, 8) : [];
  const abi = abis.find(value => APK_ABIS.includes(value) && variants[value]);
  return abi ? { ...variants[abi], architecture: abi } : {
    apk_url: row.apk_url, sha256: row.sha256 || null, architecture: 'universal',
  };
}

module.exports = { APK_ABIS, normalizeApkVariants, readApkVariants, selectApkVariant };
