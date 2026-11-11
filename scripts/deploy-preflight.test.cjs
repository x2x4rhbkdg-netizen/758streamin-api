"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { configuration, preflight, latestPrepared } = require('./deploy-preflight.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streamin-preflight-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'live'), live = path.join(root, 'baseline');
  const state = `${target}.deploy`, candidate = path.join(state, 'releases', 'new');
  const procRoot = path.join(root, 'proc');
  for (const directory of [live, candidate]) {
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.deploy-release.json'), JSON.stringify({ id: directory === live ? 'old' : 'new' }));
    fs.writeFileSync(path.join(directory, 'src/app.js'), `
      throw new Error('PREFLIGHT_MUST_NOT_LOAD_APP');
      const backgroundJobsEnabled = process.env.DISABLE_BACKGROUND_JOBS !== '1';
      if (backgroundJobsEnabled) { createWhmcsStatusSync(); startDeviceTransferCleanup(); }
      app.get('/health', handler);
    `);
    fs.writeFileSync(path.join(directory, 'src/server.js'), `
      let shuttingDown = false;
      const deadline = setTimeout(() => process.exit(1), 15000);
      server.close(() => pool.end());
    `);
  }
  fs.symlinkSync(live, target);
  fs.writeFileSync(path.join(state, 'new.json'), JSON.stringify({ id: 'new', state: 'prepared', release: candidate }));
  fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true });
  const external = path.join(root, 'persistent'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(procRoot, '4242/environ'), `DB_PASSWORD=DO_NOT_PRINT_DB_SECRET\0PORT=3001\0DISABLE_BACKGROUND_JOBS=1\0HOME_AD_UPLOAD_DIR=${external}\0NOTIFICATION_IMAGE_UPLOAD_DIR=${external}\0`);
  const config = { ...configuration({ DEPLOY_TARGET: target }, []), procRoot };
  const calls = [];
  const services = {
    inspect(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: `ActiveState=active\nSubState=running\nMainPID=4242\nUser=fixture\nWorkingDirectory=${target}\nTimeoutStopUSec=1min 30s\n` };
    },
    fetcher: async url => new Response(JSON.stringify({ ok: true, service: '758streamin API',
      release: new URL(url).port === '3002' ? 'new' : 'old' }), { status: 200 }),
  };
  return { root, target, live, state, candidate, procRoot, config, services, calls };
}

const codes = report => report.findings.map(item => item.code);

test('defaults match the supplied system service and loopback port without enabling activation', () => {
  const config = configuration({ DEPLOY_ACTIVATE: '1', DEPLOY_ALLOW_RESTART: '1' }, []);
  assert.equal(config.healthUrl, 'http://127.0.0.1:3001/health');
  assert.equal(config.unit, '758streamin-api.service'); assert.equal(config.scope, 'system');
  assert.equal(config.activate, undefined); assert.equal(config.restart, undefined);
});

test('only local /health GET probes and explicit systemd units are accepted', () => {
  for (const url of ['http://example.com/health', 'http://127.0.0.1.evil/health', 'http://secret@127.0.0.1/health',
    'http://127.0.0.1/restart', 'http://127.0.0.1/health?token=secret']) {
    assert.throws(() => configuration({ DEPLOY_HEALTH_URL: url }, []), /loopback/);
  }
  assert.throws(() => configuration({ DEPLOY_SYSTEMD_UNIT: 'bad;command.service' }, []), /unit/);
  assert.throws(() => configuration({}, ['--release']), /Usage/);
});

test('managed baseline reports facts, exact release identity and only read-only service queries', async t => {
  const f = fixture(t);
  const report = await preflight(f.config, f.services);
  assert.equal(report.candidate, f.candidate);
  assert.equal(report.blockerCount, 0); assert.equal(report.status, 'manual-review-required');
  assert.equal(report.activationAttempted, false);
  assert.equal(report.liveHealth.releaseMatches, true);
  assert.equal(report.service.disableBackgroundJobs, true);
  assert.equal(report.backgroundJobOwnershipVerified, false);
  assert.equal(report.candidateSource.shutdownDeadlineMs, 15000);
  assert.equal(report.candidateSource.backgroundDisableGate, true);
  assert.equal(report.uploadPaths.HOME_AD_UPLOAD_DIR.verified, true);
  assert.ok(codes(report).includes('TRAFFIC_DRAIN_UNVERIFIED'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, 'systemctl'); assert.ok(f.calls[0].args.includes('show'));
  assert.equal(f.calls[0].args.some(value => ['restart', 'start', 'stop', 'Environment'].includes(value)), false);
  assert.equal(JSON.stringify(report).includes('DO_NOT_PRINT_DB_SECRET'), false);
});

test('ordinary layout, missing marker and missing live health remain migration blockers', async t => {
  const f = fixture(t); fs.unlinkSync(f.target); fs.renameSync(f.live, f.target);
  fs.unlinkSync(path.join(f.target, '.deploy-release.json'));
  f.services.fetcher = async () => new Response('private upstream error body', { status: 404 });
  const report = await preflight(f.config, f.services);
  assert.equal(report.status, 'blocked');
  for (const code of ['LIVE_NOT_MANAGED', 'LIVE_MARKER_MISSING', 'BASELINE_NOT_HEALTHY']) assert.ok(codes(report).includes(code));
  assert.equal(JSON.stringify(report).includes('private upstream'), false);
});

test('secrets and runtime directories are inventoried without reading contents or changing files', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.live, '.env'), 'DO_NOT_PRINT_ENV_SECRET');
  fs.writeFileSync(path.join(f.live, 'api.env'), 'DO_NOT_PRINT_API_SECRET');
  fs.mkdirSync(path.join(f.live, 'tmp'));
  fs.writeFileSync(path.join(f.live, 'tmp/private'), 'DO_NOT_PRINT_RUNTIME_SECRET');
  fs.writeFileSync(path.join(f.live, 'local-only.txt'), 'local');
  fs.writeFileSync(path.join(f.candidate, 'new-file.txt'), 'new');
  fs.appendFileSync(path.join(f.candidate, 'src/app.js'), '\n// source changed');
  const before = fs.readdirSync(f.root).sort();
  const report = await preflight(f.config, f.services), output = JSON.stringify(report);
  assert.deepEqual(fs.readdirSync(f.root).sort(), before);
  assert.equal(fs.readFileSync(path.join(f.live, '.env'), 'utf8'), 'DO_NOT_PRINT_ENV_SECRET');
  assert.deepEqual(report.environmentFiles.live, ['.env', 'api.env']);
  assert.equal(report.runtimeDirectories.live[0].path, 'tmp');
  assert.ok(report.differences.samples.onlyLive.includes('local-only.txt'));
  assert.ok(report.differences.samples.onlyRelease.includes('new-file.txt'));
  assert.ok(report.differences.samples.changed.includes('src/app.js'));
  assert.ok(report.behaviorChanges.includes('src/app.js'));
  assert.equal(/DO_NOT_PRINT_/.test(output), false);
});

test('candidate selection ignores incomplete records and paths outside release storage', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, 'zz-incomplete.json'), JSON.stringify({ state: 'prepared', id: 'missing', release: f.candidate }));
  fs.writeFileSync(path.join(f.state, 'zz-external.json'), JSON.stringify({ state: 'prepared', id: 'old', release: f.live }));
  fs.writeFileSync(path.join(f.state, 'zz-active.json'), JSON.stringify({ state: 'active', id: 'new', release: f.candidate }));
  assert.equal(latestPrepared(f.state), f.candidate);
});

test('symlinks and bounded scans cannot masquerade as complete comparisons', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'private-file'); fs.writeFileSync(outside, 'DO_NOT_PRINT_EXTERNAL');
  for (const directory of [f.live, f.candidate]) fs.symlinkSync(outside, path.join(directory, 'external'));
  const report = await preflight(f.config, f.services);
  assert.ok(codes(report).includes('INCOMPLETE_COMPARISON'));
  assert.ok(report.differences.samples.unchecked.includes('external'));
  assert.equal(JSON.stringify(report).includes('DO_NOT_PRINT_EXTERNAL'), false);
  const limited = await preflight({ ...f.config, maxEntries: 1 }, f.services);
  assert.equal(limited.scan.truncated, true);
  assert.ok(codes(limited).includes('INCOMPLETE_COMPARISON'));
});

test('stale release identity, incorrect port and unhealthy candidate listener are reported', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.procRoot, '4242/environ'), 'PORT=3000\0');
  f.services.fetcher = async () => new Response(JSON.stringify({ ok: true, service: '758streamin API', release: 'stale' }));
  const report = await preflight({ ...f.config, candidateHealthUrl: 'http://127.0.0.1:3002/health' }, f.services);
  for (const code of ['BASELINE_NOT_HEALTHY', 'PORT_MISMATCH', 'CANDIDATE_NOT_HEALTHY']) assert.ok(codes(report).includes(code));
});

test('optional candidate listener is checked without starting the application', async t => {
  const f = fixture(t);
  const report = await preflight({ ...f.config, candidateHealthUrl: 'http://127.0.0.1:3002/health' }, f.services);
  assert.equal(report.candidateHealth.releaseMatches, true);
  assert.equal(codes(report).includes('CANDIDATE_NOT_RUNNING'), false);
});

test('missing systemd and unavailable /proc are unknown rather than assumed safe', async t => {
  const f = fixture(t);
  f.services.inspect = () => ({ status: null, error: { code: 'ENOENT' } });
  const report = await preflight(f.config, f.services);
  assert.ok(codes(report).includes('SERVICE_UNKNOWN'));
  assert.ok(codes(report).includes('ENVIRONMENT_UNKNOWN'));
  assert.equal(report.service.disableBackgroundJobs, undefined);
});

test('upload directories inside a release are flagged instead of treated as persistent', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.procRoot, '4242/environ'), `PORT=3001\0HOME_AD_UPLOAD_DIR=${f.live}\0`);
  const report = await preflight(f.config, f.services);
  assert.equal(report.uploadPaths.HOME_AD_UPLOAD_DIR.verified, false);
  assert.ok(codes(report).includes('UPLOAD_PATH_NOT_PERSISTENT'));
});

test('health responses are bounded and error bodies are never included in reports', async t => {
  const f = fixture(t);
  f.services.fetcher = async () => new Response('DO_NOT_PRINT_BODY'.repeat(5000));
  const report = await preflight(f.config, f.services);
  assert.equal(report.liveHealth.healthy, false);
  assert.equal(JSON.stringify(report).includes('DO_NOT_PRINT_BODY'), false);
});

test('CLI returns blocked status as JSON and ignores activation flags without writing state', t => {
  const f = fixture(t), before = fs.readdirSync(f.state).sort();
  const result = spawnSync(process.execPath, [require.resolve('./deploy-preflight.cjs'), '--json', '--release', f.candidate], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DEPLOY_TARGET: f.target, DEPLOY_STATE: f.state, DEPLOY_ACTIVATE: '1',
      DEPLOY_ALLOW_RESTART: '1', DEPLOY_HEALTH_URL: 'http://127.0.0.1:1/health',
      DEPLOY_PREFLIGHT_CANDIDATE_HEALTH_URL: '', DEPLOY_SYSTEMD_UNIT: '758streamin-api.service', DEPLOY_SYSTEMD_SCOPE: 'system' },
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true); assert.equal(report.activationAttempted, false);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(fs.readdirSync(f.state).sort(), before);
  assert.equal(fs.realpathSync(f.target), f.live);
});
