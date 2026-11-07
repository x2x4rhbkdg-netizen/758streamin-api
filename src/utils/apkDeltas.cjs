const FORMAT = 'bsdiff43-gzip-v1';
const ARCHES = ['universal', 'arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
function normalizeApkDeltas(value) {
  if (value == null) return [];
  const invalid = () => { throw Object.assign(new Error('Invalid delta_patches metadata'), { status: 400 }); };
  if (!Array.isArray(value) || value.length > 40) return invalid();
  const seen = new Set();
  return value.map(item => {
    if (!item || item.format !== FORMAT || !ARCHES.includes(item.architecture) ||
        !hash(item.from_sha256) || !hash(item.to_sha256) || !hash(item.patch_sha256) ||
        !Number.isSafeInteger(item.from_version_code) || item.from_version_code <= 0 ||
        !Number.isSafeInteger(item.patch_size) || item.patch_size <= 0 ||
        !Number.isSafeInteger(item.to_size) || item.to_size <= 0 || item.to_size > 1024 ** 3 ||
        item.patch_size >= item.to_size * .8 || typeof item.patch_url !== 'string' || item.patch_url.length > 2000) return invalid();
    let url; try { url = new URL(item.patch_url); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password) return invalid();
    const key = `${item.from_version_code}:${item.from_sha256.toLowerCase()}:${item.architecture}`;
    if (seen.has(key)) return invalid(); seen.add(key);
    return { format: FORMAT, architecture: item.architecture, from_version_code: item.from_version_code,
      from_sha256: item.from_sha256.toLowerCase(), to_sha256: item.to_sha256.toLowerCase(),
      patch_sha256: item.patch_sha256.toLowerCase(), patch_url: url.href,
      patch_size: item.patch_size, to_size: item.to_size };
  });
}
function readApkDeltas(value) {
  try { return normalizeApkDeltas(typeof value === 'string' ? JSON.parse(value) : value); } catch { return []; }
}
function selectApkDelta(row, request, variants) {
  if (row.channel !== 'direct' || !Array.isArray(request?.delta_formats) || !request.delta_formats.includes(FORMAT) || !hash(request.installed_sha256)) return null;
  const eligible = readApkDeltas(row.delta_patches).filter(patch => {
    const target = patch.architecture === 'universal' ? { apk_url: row.apk_url, sha256: row.sha256 } : variants[patch.architecture];
    return /^https:\/\//i.test(target?.apk_url || '') && patch.from_version_code === Number(request.version_code) && patch.from_version_code < Number(row.version_code) &&
      patch.from_sha256 === request.installed_sha256.toLowerCase() && target?.sha256?.toLowerCase() === patch.to_sha256 &&
      (patch.architecture === 'universal' || Array.isArray(request.supported_abis) && request.supported_abis.includes(patch.architecture));
  }).sort((a, b) => a.patch_size - b.patch_size);
  const delta = eligible[0];
  if (!delta) return null;
  const target = delta.architecture === 'universal' ? { apk_url: row.apk_url, sha256: row.sha256 } : variants[delta.architecture];
  return { ...target, architecture: delta.architecture, delta };
}
module.exports = { FORMAT, normalizeApkDeltas, readApkDeltas, selectApkDelta };
