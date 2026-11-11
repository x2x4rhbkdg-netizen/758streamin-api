const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configuration, deploy } = require('./deploy.cjs');

function fixture(t, activate = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streamin-deploy-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'checkout'), target = path.join(root, 'live');
  for (const dir of [source, target]) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/server.js'), `module.exports = '${dir === source ? 'new' : 'old'}';\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: {} }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: {} }));
  }
  fs.mkdirSync(path.join(target, 'node_modules'));
  fs.writeFileSync(path.join(target, 'node_modules/sentinel'), 'old modules');
  fs.writeFileSync(path.join(target, '.env'), 'fixture-secret');
  fs.writeFileSync(path.join(target, '.deploy-release.json'), JSON.stringify({ id: 'old' }));
  fs.mkdirSync(path.join(target, 'tmp')); fs.writeFileSync(path.join(target, 'tmp/runtime'), 'runtime');
  if (activate) { const old = path.join(root, 'old'); fs.renameSync(target, old); fs.symlinkSync(old, target); }
  const config = { ...configuration({ DEPLOY_TARGET: target }, source), attempts: 1, intervalMs: 0 };
  if (activate) Object.assign(config, { activate: true, restart: true, unit: 'streamin-api.service' });
  const calls = [];
  const services = { log() {}, sleep: async () => {},
    exec(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (command === 'npm' || command === 'systemctl' || command === 'sudo') return;
      const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'command failed');
    },
    fetcher: async () => ({ status: 200, json: async () => ({ ok: true, service: '758streamin API',
      release: JSON.parse(fs.readFileSync(path.join(target, '.deploy-release.json'), 'utf8')).id }) }),
  };
  return { config, services, calls, root, source, target };
}

test('default cPanel deployment validates and backs up without changing live files or restarting', async t => {
  const f = fixture(t);
  const result = await deploy(f.config, f.services);
  assert.equal(result.state, 'prepared');
  assert.match(fs.readFileSync(path.join(f.target, 'src/server.js'), 'utf8'), /old/);
  assert.match(fs.readFileSync(path.join(result.release, 'src/server.js'), 'utf8'), /new/);
  assert.match(fs.readFileSync(path.join(result.backup, 'src/server.js'), 'utf8'), /old/);
  assert.equal(fs.readFileSync(path.join(result.backup, 'node_modules/sentinel'), 'utf8'), 'old modules');
  for (const dir of [result.release, result.backup]) {
    assert.equal(fs.existsSync(path.join(dir, '.env')), false);
    assert.equal(fs.existsSync(path.join(dir, 'tmp/runtime')), false);
  }
  assert.equal(fs.readFileSync(path.join(f.target, '.env'), 'utf8'), 'fixture-secret');
  assert.equal(f.calls.some(call => call.command === 'systemctl' || call.command === 'sudo'), false);
  assert.equal(f.calls.some(call => call.command === 'npm' && call.args[0] === 'ci'), false);
  assert.equal(f.calls.some(call => call.command === 'npm' && call.args[0] === 'ls'), true);
});

for (const name of ['package.json', 'package-lock.json']) {
  test(`${name} changes trigger a fresh production dependency install`, async t => {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.source, name), '\n');
    await deploy(f.config, f.services);
    const install = f.calls.find(call => call.command === 'npm' && call.args[0] === 'ci');
    assert.deepEqual(install.args, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts']);
    assert.notEqual(install.cwd, f.target);
    assert.equal(fs.readFileSync(path.join(f.target, 'node_modules/sentinel'), 'utf8'), 'old modules');
  });
}

test('invalid JavaScript fails before touching the live deployment', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'src/server.js'), 'const broken = ;');
  await assert.rejects(deploy(f.config, f.services), /SyntaxError/);
  assert.match(fs.readFileSync(path.join(f.target, 'src/server.js'), 'utf8'), /old/);
  assert.equal(fs.existsSync(path.join(f.config.state, 'lock')), false);
});

test('failed dependency validation cannot activate a release', async t => {
  const f = fixture(t, true), exec = f.services.exec, old = fs.readlinkSync(f.target);
  f.services.exec = (command, args, cwd) => {
    if (command === 'npm') throw new Error('dependency check failed');
    exec(command, args, cwd);
  };
  await assert.rejects(deploy(f.config, f.services), /dependency check failed/);
  assert.equal(fs.readlinkSync(f.target), old);
  assert.equal(f.calls.some(call => call.command === 'systemctl'), false);
});

test('opt-in activation atomically switches the release and restarts only the configured unit', async t => {
  const f = fixture(t, true);
  const result = await deploy(f.config, f.services);
  assert.equal(result.state, 'active');
  assert.equal(fs.realpathSync(f.target), result.release);
  assert.deepEqual(f.calls.filter(call => call.command === 'systemctl').map(call => call.args), [
    ['--user', 'is-active', '--quiet', 'streamin-api.service'], ['--user', 'restart', 'streamin-api.service'],
  ]);
});

test('stale health release IDs trigger rollback and a second controlled restart', async t => {
  const f = fixture(t, true), old = fs.readlinkSync(f.target);
  f.services.fetcher = async () => ({ status: 200, json: async () => ({ ok: true, service: '758streamin API', release: 'old' }) });
  await assert.rejects(deploy(f.config, f.services), /was rolled back/);
  assert.equal(fs.readlinkSync(f.target), old);
  assert.equal(f.calls.filter(call => call.command === 'systemctl' && call.args.includes('restart')).length, 2);
});

test('restart failure restores the previous release and retries its restart', async t => {
  const f = fixture(t, true), exec = f.services.exec, old = fs.readlinkSync(f.target);
  let restarts = 0;
  f.services.exec = (command, args, cwd) => {
    exec(command, args, cwd);
    if (command === 'systemctl' && args.includes('restart') && ++restarts === 1) throw new Error('restart failed');
  };
  await assert.rejects(deploy(f.config, f.services), /was rolled back: restart failed/);
  assert.equal(fs.readlinkSync(f.target), old); assert.equal(restarts, 2);
});

test('failed rollback health check explicitly reports that recovery needs attention', async t => {
  const f = fixture(t, true), healthy = f.services.fetcher, old = fs.readlinkSync(f.target);
  let probes = 0;
  f.services.fetcher = async () => ++probes === 1 ? healthy() : { status: 503, json: async () => ({ ok: false }) };
  await assert.rejects(deploy(f.config, f.services), /previous pointer restored but service recovery needs attention/);
  assert.equal(fs.readlinkSync(f.target), old);
});

test('unhealthy current service fails before changing its release pointer', async t => {
  const f = fixture(t, true), old = fs.readlinkSync(f.target);
  f.services.fetcher = async () => { throw new Error('connection refused'); };
  await assert.rejects(deploy(f.config, f.services), /Current release is not healthy/);
  assert.equal(fs.readlinkSync(f.target), old);
  assert.equal(f.calls.some(call => call.command === 'systemctl'), false);
});

test('restart gates, a regular live directory and concurrent deployments are refused', async t => {
  const f = fixture(t);
  await assert.rejects(deploy({ ...f.config, restart: true }, f.services), /Restart requires/);
  await assert.rejects(deploy({ ...f.config, activate: true }, f.services), /Activation requires/);
  await assert.rejects(deploy({ ...f.config, activate: true, restart: true }, f.services), /existing release symlink/);
  fs.mkdirSync(path.join(f.config.state, 'lock'), { recursive: true });
  await assert.rejects(deploy(f.config, f.services), /Another deployment holds the lock/);
});

test('system services use non-interactive sudo for the explicitly configured unit', async t => {
  const f = fixture(t, true);
  f.config.scope = 'system';
  await deploy(f.config, f.services);
  assert.deepEqual(f.calls.filter(call => call.command === 'sudo').map(call => call.args), [
    ['-n', 'systemctl', 'is-active', '--quiet', 'streamin-api.service'],
    ['-n', 'systemctl', 'restart', 'streamin-api.service'],
  ]);
});

test('invalid units and non-loopback probes fail before activation', async t => {
  const f = fixture(t, true), old = fs.readlinkSync(f.target);
  await assert.rejects(deploy({ ...f.config, unit: 'invalid;command' }, f.services), /explicit systemd service unit/);
  await assert.rejects(deploy({ ...f.config, healthUrl: 'https://api.example/health' }, f.services), /direct HTTP loopback/);
  assert.equal(fs.readlinkSync(f.target), old); assert.equal(f.calls.length, 0);
});

test('real npm prepares a dependency-free release and does not run lifecycle scripts', async t => {
  const f = fixture(t), exec = f.services.exec;
  const pkg = { name: 'fixture', version: '1.0.0', dependencies: {}, scripts: {
    postinstall: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"',
  } };
  fs.writeFileSync(path.join(f.source, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(f.source, 'package-lock.json'), JSON.stringify({ name: pkg.name,
    version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
  f.services.exec = (command, args, cwd) => {
    if (command !== 'npm') return exec(command, args, cwd);
    const result = spawnSync(command, args, { cwd, encoding: 'utf8',
      env: { ...process.env, npm_config_cache: path.join(f.root, 'npm-cache') } });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'npm failed');
  };
  const result = await deploy(f.config, f.services);
  assert.equal(result.state, 'prepared');
  assert.equal(fs.existsSync(path.join(result.release, 'lifecycle-ran')), false);
  assert.equal(fs.existsSync(path.join(result.release, 'package-lock.json')), true);
});
