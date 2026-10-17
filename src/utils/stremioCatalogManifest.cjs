function catalogDefinitions(manifest) {
  if (!manifest || typeof manifest.id !== 'string' || !Array.isArray(manifest.types) ||
      !Array.isArray(manifest.resources) || !manifest.resources.some((r) => (typeof r === 'string' ? r : r?.name) === 'catalog')) return [];
  return (Array.isArray(manifest.catalogs) ? manifest.catalogs : []).slice(0, 100).filter((catalog) => {
    if (!catalog || typeof catalog.id !== 'string' || !catalog.id || catalog.id.length > 200 ||
        typeof catalog.type !== 'string' || !manifest.types.includes(catalog.type) || catalog.type.length > 80) return false;
    if (catalog.extra != null && !Array.isArray(catalog.extra)) return false;
    if (/(?:adult|porn|hentai|erotica|xxx)/i.test(`${catalog.type} ${catalog.name || ''}`)) return false;
    return !catalog.extra?.some((extra) => !extra || typeof extra.name !== 'string' ||
      (extra.options != null && !Array.isArray(extra.options)) || (extra.isRequired && !['search', 'skip', 'genre'].includes(extra.name)));
  });
}
module.exports = { catalogDefinitions };
