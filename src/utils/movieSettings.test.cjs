const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const devices = new Map();
  let globalSettings;
  let missingTables = false;
  const vault = {
    encryptString: (value) => Buffer.from(value).toString('base64'),
    decryptString: (value) => Buffer.from(value, 'base64').toString(),
  };
  const pool = { async execute(sql, params = []) {
    if (missingTables) throw Object.assign(new Error('Missing table'), { code: 'ER_NO_SUCH_TABLE' });
    if (sql.startsWith('SELECT')) {
      const stored = sql.includes('FROM global_movie_settings') ? globalSettings : devices.get(params[0]);
      return [stored ? [{ settings_enc: stored }] : []];
    }
    if (sql.includes('INSERT INTO global_movie_settings')) globalSettings = params[0];
    else devices.set(params[0], params[1]);
    return [{}];
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'movieSettings.cjs'), 'utf8'), {
    module, URL, require(name) {
      if (name === '../db/pool.cjs') return { pool };
      if (name === './cryptoVault.cjs') return vault;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { api: module.exports, devices, vault, setMissing: () => { missingTables = true; } };
}

test('device access defaults disabled and saves independently from global settings', async () => {
  const { api } = fixture();
  assert.equal((await api.readDeviceMovieAccess(1)).enabled, false);
  await api.saveMovieSettings(1, { enabled: true });
  await api.saveGlobalMovieSettings({ provider: 'Torbox', debrid_token: 'private-key', max_links: 8 });
  const enabled = await api.readMovieSettings(1);
  const disabled = await api.readMovieSettings(2);
  assert.equal(enabled.enabled, true);
  assert.equal(disabled.enabled, false);
  assert.equal(enabled.provider, 'Torbox');
  assert.equal(disabled.provider, 'Torbox');
  assert.equal(enabled.max_links, 8);
  await api.saveMovieSettings(1, { enabled: false });
  assert.equal((await api.readGlobalMovieSettings()).debrid_token, 'private-key');
});

test('legacy per-device configuration is ignored without deleting existing records', async () => {
  const { api, devices, vault } = fixture();
  devices.set(1, vault.encryptString(JSON.stringify({ enabled: true, provider: 'Real-Debrid', debrid_token: 'legacy' })));
  await api.saveGlobalMovieSettings({ provider: 'Torbox', debrid_token: 'shared' });
  assert.equal((await api.readMovieSettings(1)).debrid_token, 'shared');
  assert.deepEqual(Object.keys(await api.readDeviceMovieAccess(1)), ['enabled']);
  await api.saveMovieSettings(1, { enabled: false });
  assert.equal(JSON.parse(vault.decryptString(devices.get(1))).debrid_token, 'legacy');
});

test('device saves reject configuration fields and global saves reject access switches', async () => {
  const { api } = fixture();
  await assert.rejects(api.saveMovieSettings(1, { enabled: true, provider: 'Torbox' }), { status: 400 });
  await assert.rejects(api.saveMovieSettings(1, { enabled: 'true' }), { status: 400 });
  await assert.rejects(api.saveGlobalMovieSettings({ enabled: true }), { status: 400 });
});

test('public and admin responses mask secrets; only global admin response includes scraper URL', async () => {
  const { api } = fixture();
  const settings = await api.saveGlobalMovieSettings({ scraper_url: 'https://example.com/?key=private',
    tmdb_read_access_token: 'tmdb-secret', provider: 'Torbox', debrid_token: 'provider-secret', trakt_access_token: 'trakt-secret' });
  const publicData = api.publicSettings(settings);
  const adminData = api.adminGlobalSettings(settings);
  assert.equal(publicData.scraper_url, undefined);
  assert.equal(adminData.scraper_url, settings.scraper_url);
  assert.equal(adminData.enabled, undefined);
  for (const key of ['tmdb_read_access_token', 'debrid_token', 'trakt_access_token']) {
    assert.equal(publicData[key], undefined);
    assert.equal(adminData[key], undefined);
    assert.equal(adminData[`${key}_configured`], true);
  }
});

test('global partial updates preserve credentials; provider changes clear its credential', async () => {
  const { api } = fixture();
  await api.saveGlobalMovieSettings({ provider: 'Torbox', debrid_token: 'secret', tmdb_read_access_token: 'tmdb' });
  await api.saveGlobalMovieSettings({ max_links: 5 });
  assert.equal((await api.readGlobalMovieSettings()).debrid_token, 'secret');
  await api.saveGlobalMovieSettings({ provider: 'Real-Debrid' });
  const settings = await api.readGlobalMovieSettings();
  assert.equal(settings.debrid_token, '');
  assert.equal(settings.tmdb_read_access_token, 'tmdb');
  await assert.rejects(api.saveGlobalMovieSettings({ max_links: 51 }), { status: 400 });
});

test('missing tables default access off and prevent pretending saves succeeded', async () => {
  const { api, setMissing } = fixture();
  setMissing();
  assert.equal((await api.readMovieSettings(1)).enabled, false);
  await assert.rejects(api.saveGlobalMovieSettings({ provider: 'Torbox' }), { code: 'ER_NO_SUCH_TABLE' });
  await assert.rejects(api.saveMovieSettings(1, { enabled: true }), { code: 'ER_NO_SUCH_TABLE' });
});

test('multiple providers remain enabled with independent credentials and masked responses', async () => {
  const { api } = fixture();
  await api.saveGlobalMovieSettings({ provider_accounts: {
    Torbox: { enabled: true, token: 'torbox-key' },
    'Real-Debrid': { enabled: true, token: 'rd-key' },
  } });
  await api.saveGlobalMovieSettings({ max_links: 12 });
  let settings = await api.readGlobalMovieSettings();
  assert.equal(settings.provider_accounts.Torbox.enabled, true);
  assert.equal(settings.provider_accounts['Real-Debrid'].enabled, true);
  const response = api.adminGlobalSettings(settings);
  assert.equal(response.provider_accounts.Torbox.token, undefined);
  assert.equal(response.provider_accounts.Torbox.token_configured, true);
  assert.equal(api.publicSettings(settings).provider_accounts['Real-Debrid'].token, undefined);
  await api.saveGlobalMovieSettings({ provider_accounts: { Torbox: { enabled: false } } });
  settings = await api.readGlobalMovieSettings();
  assert.equal(settings.provider_accounts.Torbox.token, 'torbox-key');
  assert.equal(settings.provider_accounts['Real-Debrid'].enabled, true);
  await api.saveGlobalMovieSettings({ provider_accounts: { Torbox: { token: '' } } });
  settings = await api.readGlobalMovieSettings();
  assert.equal(settings.provider_accounts.Torbox.token, '');
  assert.equal(settings.provider_accounts['Real-Debrid'].token, 'rd-key');
});

test('legacy global provider is preserved when adding a second provider', async () => {
  const { api } = fixture();
  await api.saveGlobalMovieSettings({ provider: 'Torbox', debrid_token: 'existing' });
  await api.saveGlobalMovieSettings({ provider_accounts: { Premiumize: { enabled: true, token: 'new' } } });
  const settings = await api.readGlobalMovieSettings();
  assert.equal(settings.provider_accounts.Torbox.token, 'existing');
  assert.equal(settings.provider_accounts.Torbox.enabled, true);
  assert.equal(settings.provider_accounts.Premiumize.enabled, true);
});

test('provider account updates validate names, booleans and credential types', async () => {
  const { api } = fixture();
  for (const provider_accounts of [[], { Unknown: {} }, { Torbox: { enabled: 'yes' } },
    { Torbox: { token: 123 } }, { Torbox: { token: 'x'.repeat(8193) } }, { Torbox: { extra: true } }]) {
    await assert.rejects(api.saveGlobalMovieSettings({ provider_accounts }), { status: 400 });
  }
});

test('global sorting and codec preferences validate while device control remains only enabled', async () => {
  const { api } = fixture();
  await api.saveGlobalMovieSettings({ primary_sort: 'size', primary_sort_direction: 'asc', min_bitrate_mbps: 10,
    max_bitrate_mbps: 100, auto_select_delay: true, auto_select_delay_seconds: 15, enable_software_codecs: true, prefer_software_codecs: true });
  let settings = await api.readGlobalMovieSettings();
  assert.equal(settings.primary_sort, 'size');
  assert.equal(settings.prefer_software_codecs, true);
  await api.saveGlobalMovieSettings({ enable_software_codecs: false });
  assert.equal((await api.readGlobalMovieSettings()).prefer_software_codecs, false);
  await assert.rejects(api.saveGlobalMovieSettings({ min_bitrate_mbps: 100, max_bitrate_mbps: 20 }), { status: 400 });
  await assert.rejects(api.saveGlobalMovieSettings({ primary_sort: 'invalid' }), { status: 400 });
  await assert.rejects(api.saveGlobalMovieSettings({ secondary_sort_direction: 'invalid' }), { status: 400 });
  await assert.rejects(api.saveMovieSettings(1, { enabled: true, primary_sort: 'size' }), { status: 400 });
});
