const { createAdultAddonClient, adultAddons, addonVersion } = require('./adultAddons.cjs');
const { ID, provider, parseItem, createThePornDbClient } = require('./thePornDb.cjs');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function adultCatalogProviders(settings) {
  const tpdb = provider(settings);
  return [...(tpdb ? [tpdb] : []), ...adultAddons(settings)];
}
function validateAdultSelection(settings, item, source) {
  const owner = adultCatalogProviders(settings).find(entry => entry.id === item.addon_id);
  if (!owner || addonVersion(owner) !== item.addon_version) throw fail('Adult catalog changed. Open its catalog again.');
  if (item.addon_id === ID) {
    // Catalog identity is distinct from source-provider identity. Never use fuzzy title matching.
    parseItem(item);
    if (source) {
      const addon = adultAddons(settings).find(entry => entry.id === source.source_addon_id);
      if (!addon || addonVersion(addon) !== source.source_addon_version) throw fail('Adult source add-on changed. Search for links again.');
    }
  }
}
function createAdultCatalogClient({ addons = createAdultAddonClient(), tpdb = createThePornDbClient() } = {}) {
  return {
    async catalogs(settings) {
      const hasTpdb = !!provider(settings);
      let result = { catalogs: [], diagnostics: [] };
      if (adultAddons(settings).length) {
        try { result = await addons.catalogs(settings); }
        catch (error) { if (!hasTpdb) throw error; result.diagnostics.push({ id: 'addons', status: 'unavailable' }); }
      }
      if (!hasTpdb && !result.catalogs.length) throw fail('Configure ThePornDB or an Adult source add-on in Media Settings');
      return { ...result, catalogs: [...(hasTpdb ? tpdb.catalogs() : []), ...result.catalogs] };
    },
    async catalog(settings, input) {
      if (input.addon_id !== ID) return addons.catalog(settings, input);
      const result = await tpdb.catalog(settings, input);
      return { ...result, items: result.items.map(item => ({ ...item, addon_id: ID, addon_version: addonVersion(provider(settings)) })) };
    },
    async details(settings, item) {
      validateAdultSelection(settings, item);
      return item.addon_id === ID ? tpdb.details(settings, item) : addons.details(settings, item);
    },
    async sources(settings, item) {
      validateAdultSelection(settings, item);
      return item.addon_id === ID ? addons.metadataSources(settings, item) : addons.sources(settings, item);
    },
  };
}
module.exports = { adultCatalogProviders, validateAdultSelection, createAdultCatalogClient };
