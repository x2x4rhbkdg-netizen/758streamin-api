const { createAdultAddonClient, adultAddons, addonVersion } = require('./adultAddons.cjs');
const { ID, provider, parseItem, createThePornDbClient } = require('./thePornDb.cjs');
const { createHash } = require('node:crypto');
const { discoverSources } = require('./Scraper.cjs');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function adultScraperSettings(settings) {
  const urls = [settings.scraper_url, settings.secondary_scraper_url].map(value => {
    if (typeof value !== 'string' || !value) return '';
    try { return new URL(value).pathname.endsWith('/manifest.json') ? '' : value; } catch { return ''; }
  });
  return { ...settings, scraper_url: urls[0], secondary_scraper_url: urls[1], stremio_addons: [] };
}
function scraperVersion(settings) {
  const scoped = adultScraperSettings(settings);
  return createHash('sha256').update(JSON.stringify(['adult-scrapers-v1', scoped.scraper_url, scoped.secondary_scraper_url])).digest('hex');
}
function adultCatalogProviders(settings) {
  const tpdb = provider(settings);
  return [...(tpdb ? [tpdb] : []), ...adultAddons(settings)];
}
function validateAdultSelection(settings, item, source) {
  const owner = adultCatalogProviders(settings).find(entry => entry.id === item.addon_id);
  if (!owner || addonVersion(owner) !== item.addon_version) throw fail('Adult catalog changed. Open its catalog again.');
  if (item.addon_id === ID) {
    // Catalog identity and source ownership are checked independently.
    parseItem(item);
    if (source) {
      if (source.source_kind === 'shared_scraper') {
        if (settings.adult_use_shared_scrapers !== true || source.source_scraper_version !== scraperVersion(settings) ||
            !/^[a-f0-9]{40}$/.test(source.hash || '') || source.url) throw fail('Adult scraper settings changed. Search for links again.');
        return;
      }
      const addon = adultAddons(settings).find(entry => entry.id === source.source_addon_id);
      if (!addon || addonVersion(addon) !== source.source_addon_version) throw fail('Adult source add-on changed. Search for links again.');
    }
  }
}
function createAdultCatalogClient({ addons = createAdultAddonClient(), tpdb = createThePornDbClient(), discover = discoverSources } = {}) {
  let activeScrapers = 0;
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
      if (item.addon_id !== ID) return addons.sources(settings, item);
      if (settings.adult_use_shared_scrapers !== true) return addons.metadataSources(settings, item);
      const scoped = adultScraperSettings(settings);
      const searchable = typeof item.title === 'string' && item.title.length <= 200 && /[a-z0-9]/i.test(item.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
      if (!(scoped.scraper_url || scoped.secondary_scraper_url) || !searchable) return addons.metadataSources(settings, item);
      if (activeScrapers >= 2) throw fail('Adult source search is busy. Try again shortly.', 429);
      activeScrapers++;
      try {
        // The encrypted item contains server-sourced metadata, never a client-supplied search title.
        const [addonSources, result] = await Promise.all([addons.metadataSources(settings, item),
          discover(scoped, { type: 'movie', title: item.title, ...(Number.isInteger(item.year) ? { year_int: item.year } : {}) })]);
        const hashes = new Set(addonSources.map(source => source.hash).filter(Boolean));
        const sources = (result.sources || []).filter(source => /^[a-f0-9]{40}$/.test(source.hash || '') && !hashes.has(source.hash))
          .slice(0, 100).map(source => ({ hash: source.hash, title: source.title,
            quality: source.quality, size_bytes: source.size_bytes, bitrate_mbps: source.bitrate_mbps, scraper: source.scraper,
            source_kind: 'shared_scraper', source_scraper_version: scraperVersion(settings) }));
        return [...addonSources, ...sources].slice(0, 100);
      } finally { activeScrapers--; }
    },
  };
}
module.exports = { adultCatalogProviders, validateAdultSelection, createAdultCatalogClient, adultScraperSettings, scraperVersion };
