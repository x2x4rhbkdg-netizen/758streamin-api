const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streamin-activate-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'), live = path.join(root, 'live');
  const state = path.join(root, 'live.deploy'), release = path.join(state, 'releases', 'new-release');
  const bin = path.join(root, 'bin'), calls = path.join(root, 'service-calls');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  for (const name of ['activate-prepared.sh', 'deploy.cjs', 'deploy-preflight.cjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(checkout, 'scripts', name));
  }
  const timestamp = new Date('2026-01-01');
  for (const dir of [checkout, live, release]) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/app.js'), `module.exports = '${dir === live ? 'old' : 'new'}';\n`);
    // Equal timestamps and byte counts exercise checksum-based rsync.
    fs.utimesSync(path.join(dir, 'src/app.js'), timestamp, timestamp);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  }
  for (const dir of [live, release]) {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules/keep'), 'modules');
    fs.writeFileSync(path.join(dir, '.deploy-release.json'), JSON.stringify({ id: dir === live ? 'old-release' : 'new-release' }));
  }
  fs.chmodSync(state, 0o700);
  fs.writeFileSync(path.join(state, '2026-01-01.json'), JSON.stringify({ id: 'new-release', state: 'prepared', release }));
  for (const name of ['.env', '.env.production', 'local.env', 'runtime.log']) fs.writeFileSync(path.join(live, name), 'SECRET');
  for (const name of ['tmp', 'uploads', 'data', 'storage']) {
    fs.mkdirSync(path.join(live, name)); fs.writeFileSync(path.join(live, name, 'keep'), 'runtime');
  }
  fs.mkdirSync(path.join(checkout, 'src/tmp')); fs.writeFileSync(path.join(checkout, 'src/tmp/runtime'), 'runtime');
  const executable = (name, value) => { const file = path.join(bin, name); fs.writeFileSync(file, value, { mode: 0o700 }); return file; };
  const health = path.join(root, 'health.cjs');
  fs.writeFileSync(health, `const fs=require('node:fs'),path=require('node:path');
    const id=JSON.parse(fs.readFileSync(path.join(process.env.DEPLOY_TARGET,'.deploy-release.json'))).id;
    process.exit(id===process.argv[2] && id!==process.env.FAIL_HEALTH ? 0 : 1);`);
  const node = executable('probe-node', '#!/usr/bin/env bash\nif [ "$1" = -e ] && [[ "$2" == *"fetch(u,"* ]]; then exec "$REAL_NODE" "$HEALTH_FIXTURE" "$3"; fi\nexec "$REAL_NODE" "$@"\n');
  executable('systemctl', '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SERVICE_CALLS"\nif [ "$1" = restart ] && [ "${FAIL_RESTART:-}" = 1 ]; then\n  if grep -q new-release "$DEPLOY_TARGET/.deploy-release.json"; then exit 1; fi\nfi\nexit 0\n');
  executable('sleep', '#!/usr/bin/env bash\nexit 0\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_NODE_BIN: node,
    DEPLOY_TARGET: live, DEPLOY_STATE: state, DEPLOY_SYSTEMD_UNIT: 'fixture.service',
    REAL_NODE: process.execPath, HEALTH_FIXTURE: health, SERVICE_CALLS: calls };
  function run(mode, extra = {}) {
    const result = spawnSync('bash', [path.join(checkout, 'scripts/activate-prepared.sh'), ...(mode ? [mode] : [])],
      { env: { ...env, ...extra }, cwd: root, encoding: 'utf8', timeout: 30000 });
    return { ...result, text: `${result.stdout || ''}${result.stderr || ''}` };
  }
  const serviceCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  return { root, checkout, live, state, release, run, serviceCalls };
}

test('default checks ignore runtime directories but never copy, back up or restart', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /Checks passed/); assert.doesNotMatch(f.serviceCalls(), /restart/);
  assert.match(fs.readFileSync(path.join(f.live, 'src/app.js'), 'utf8'), /old/);
  assert.equal(fs.existsSync(path.join(f.state, 'backups')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});

test('explicit activation uses the newest completed record, backs up and preserves secrets/runtime/modules', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, '9999-incomplete.json'), JSON.stringify({ id: 'incomplete', state: 'preparing', release: f.release }));
  const result = f.run('--activate');
  assert.equal(result.status, 0, result.text); assert.match(result.text, /New release is healthy: new-release/);
  assert.match(fs.readFileSync(path.join(f.live, 'src/app.js'), 'utf8'), /new/);
  const backups = fs.readdirSync(path.join(f.state, 'backups')); assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(f.state, 'backups', backups[0], 'src/app.js'), 'utf8'), /old/);
  for (const name of ['.env', '.env.production', 'local.env', 'runtime.log']) assert.equal(fs.readFileSync(path.join(f.live, name), 'utf8'), 'SECRET');
  for (const name of ['tmp', 'uploads', 'data', 'storage']) assert.equal(fs.readFileSync(path.join(f.live, name, 'keep'), 'utf8'), 'runtime');
  assert.equal(fs.readFileSync(path.join(f.live, 'node_modules/keep'), 'utf8'), 'modules');
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
  assert.equal((f.serviceCalls().match(/restart/g) || []).length, 1);
});

for (const failure of [{ FAIL_HEALTH: 'new-release' }, { FAIL_RESTART: '1' }]) {
  test(`failed ${Object.keys(failure)[0]} rolls back code and verifies the previous release`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.checkout, 'src/new.cjs'), 'module.exports = 1;');
    fs.copyFileSync(path.join(f.checkout, 'src/new.cjs'), path.join(f.release, 'src/new.cjs'));
    const result = f.run('--activate', failure);
    assert.equal(result.status, 1, result.text); assert.match(result.text, /Previous release restored and healthy: old-release/);
    assert.match(fs.readFileSync(path.join(f.live, 'src/app.js'), 'utf8'), /old/);
    assert.equal(fs.existsSync(path.join(f.live, 'src/new.cjs')), false);
    assert.equal(fs.readFileSync(path.join(f.live, '.env'), 'utf8'), 'SECRET');
    assert.equal((f.serviceCalls().match(/restart/g) || []).length, 2);
    assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
  });
}

for (const mismatch of ['source', 'dependencies', 'syntax', 'marker', 'baseline', 'lock']) {
  test(`${mismatch} failure cannot modify live files or restart`, t => {
    const f = fixture(t), extra = {};
    if (mismatch === 'source') fs.appendFileSync(path.join(f.checkout, 'src/app.js'), '// newer checkout\n');
    if (mismatch === 'dependencies') fs.appendFileSync(path.join(f.live, 'package-lock.json'), '\n');
    if (mismatch === 'syntax') for (const dir of [f.checkout, f.release]) fs.writeFileSync(path.join(dir, 'src/app.js'), 'const broken = ;');
    if (mismatch === 'marker') fs.writeFileSync(path.join(f.release, '.deploy-release.json'), '{"id":"different"}');
    if (mismatch === 'baseline') extra.FAIL_HEALTH = 'old-release';
    if (mismatch === 'lock') fs.mkdirSync(path.join(f.state, 'lock'));
    const result = f.run('--activate', extra);
    assert.notEqual(result.status, 0, result.text); assert.doesNotMatch(f.serviceCalls(), /restart/);
    assert.match(fs.readFileSync(path.join(f.live, 'src/app.js'), 'utf8'), /old/);
    assert.equal(fs.existsSync(path.join(f.state, 'backups')), false);
    assert.equal(fs.existsSync(path.join(f.state, 'lock')), mismatch === 'lock');
  });
}

test('an already active healthy release is a restart-free no-op', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.live, '.deploy-release.json'), '{"id":"new-release"}');
  const result = f.run('--activate');
  assert.equal(result.status, 0, result.text); assert.match(result.text, /already active and healthy/);
  assert.doesNotMatch(f.serviceCalls(), /restart/); assert.equal(fs.existsSync(path.join(f.state, 'backups')), false);
});

test('unsafe health URL and public backup-state permissions fail before changing live files', t => {
  const f = fixture(t);
  const invalidUrl = f.run('--activate', { DEPLOY_HEALTH_URL: 'https://remote.example/health' });
  assert.notEqual(invalidUrl.status, 0); assert.match(invalidUrl.text, /direct HTTP loopback/);
  fs.chmodSync(f.state, 0o755);
  const publicState = f.run('--activate');
  assert.notEqual(publicState.status, 0); assert.match(publicState.text, /mode 700/);
  assert.equal(f.serviceCalls(), ''); assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});

test('failed recovery retains backup and explicitly reports manual attention', t => {
  const f = fixture(t);
  // Baseline is healthy; only after the candidate is copied do both releases fail probes.
  const badProbe = path.join(f.root, 'bad-probe.cjs');
  fs.writeFileSync(badProbe, `const fs=require('node:fs'),p=require('node:path');
    const marker=p.join(process.env.DEPLOY_STATE,'candidate-tried');
    const id=JSON.parse(fs.readFileSync(p.join(process.env.DEPLOY_TARGET,'.deploy-release.json'))).id;
    if(id==='new-release')fs.writeFileSync(marker,'1');
    process.exit(!fs.existsSync(marker)&&id===process.argv[2]?0:1);`);
  const result = f.run('--activate', { HEALTH_FIXTURE: badProbe });
  assert.equal(result.status, 1, result.text); assert.match(result.text, /RECOVERY NEEDS ATTENTION/);
  assert.match(fs.readFileSync(path.join(f.live, 'src/app.js'), 'utf8'), /old/);
  assert.equal(fs.readdirSync(path.join(f.state, 'backups')).length, 1);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});
