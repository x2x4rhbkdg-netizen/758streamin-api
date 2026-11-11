"use strict";

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const EXCLUDES = ['.git/', 'node_modules/', '.env', '.env.*', 'tmp/', 'uploads/', '*.log',
  '.codex/', '.agents/', '.deploy-release.json'];
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const exists = filename => { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const nested = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function configuration(env = process.env, source = process.cwd()) {
  const target = path.resolve(env.DEPLOY_TARGET || '/home/streamin758/standalone-api');
  return {
    source: fs.realpathSync(source), target,
    state: path.resolve(env.DEPLOY_STATE || `${target}.deploy`),
    activate: env.DEPLOY_ACTIVATE === '1', restart: env.DEPLOY_ALLOW_RESTART === '1',
    unit: env.DEPLOY_SYSTEMD_UNIT || '', scope: env.DEPLOY_SYSTEMD_SCOPE || 'user',
    healthUrl: env.DEPLOY_HEALTH_URL || 'http://127.0.0.1:3000/health',
    node: env.DEPLOY_NODE_BIN || process.execPath, npm: env.DEPLOY_NPM_BIN || 'npm',
    rsync: env.DEPLOY_RSYNC_BIN || '/usr/bin/rsync',
    installScripts: env.DEPLOY_ALLOW_INSTALL_SCRIPTS === '1',
    attempts: 10, intervalMs: 1000, requestTimeoutMs: 3000,
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (exit ${result.status})`);
}

function validateSyntax(directory, node, exec) {
  let count = 0;
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', '.git', '.codex', '.agents', 'tmp', 'uploads'].includes(entry.name)) continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && /\.(?:[cm]?js)$/.test(entry.name)) { exec(node, ['--check', filename], directory); count++; }
    }
  };
  visit(directory);
  return count;
}

function dependencyDigest(directory) {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) hash.update(fs.readFileSync(path.join(directory, name)));
  return hash.digest('hex');
}

function atomicLink(link, destination) {
  const temporary = `${link}.next-${randomUUID()}`;
  fs.symlinkSync(destination, temporary);
  try { fs.renameSync(temporary, link); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}

async function healthy(config, expected, fetcher, sleep) {
  for (let attempt = 0; attempt < config.attempts; attempt++) {
    try {
      const response = await fetcher(config.healthUrl, { signal: AbortSignal.timeout(config.requestTimeoutMs), redirect: 'error' });
      const data = await response.json();
      if (response.status === 200 && data.ok === true && data.service === '758streamin API' &&
          data.release === expected) return true;
    } catch {}
    if (attempt + 1 < config.attempts) await sleep(config.intervalMs);
  }
  return false;
}

async function deploy(config, { exec = run, fetcher = fetch, sleep = delay, log = console.log } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Deployment requires Node 20+');
  if (config.target === path.parse(config.target).root || nested(config.target, config.source) ||
      nested(config.source, config.target) || nested(config.state, config.target) || nested(config.state, config.source)) {
    throw new Error('Source, live target and deployment state must be separate directories');
  }
  if (config.restart && !config.activate) throw new Error('Restart requires explicit DEPLOY_ACTIVATE=1');
  if (config.activate && !config.restart) throw new Error('Activation requires explicit DEPLOY_ALLOW_RESTART=1');
  const original = exists(config.target);
  // Preparing releases works with the existing cPanel directory. Atomic activation
  // is intentionally unavailable until its one-time symlink migration is planned.
  if (config.activate && (!original || !original.isSymbolicLink())) {
    throw new Error('Atomic activation requires an existing release symlink; see docs/DEPLOYMENT.md');
  }
  if (config.restart) {
    if (!/^[A-Za-z0-9_@.-]+\.service$/.test(config.unit) || !['user', 'system'].includes(config.scope)) {
      throw new Error('Configure an explicit systemd service unit and user/system scope');
    }
    const url = new URL(config.healthUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Health checks must use a direct HTTP loopback listener');
    }
  }
  const previous = original ? fs.realpathSync(config.target) : null;
  if (previous && (nested(config.source, previous) || nested(config.state, previous))) {
    throw new Error('Live symlink must not resolve to the checkout or deployment state root');
  }
  fs.mkdirSync(config.state, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.state, 0o700);
  const lock = path.join(config.state, 'lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another deployment holds the lock'); throw error; }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const release = path.join(config.state, 'releases', id);
  const backup = previous ? path.join(config.state, 'backups', id) : null;
  let promoted = false;
  const restart = () => config.scope === 'user'
    ? exec('systemctl', ['--user', 'restart', config.unit], config.source)
    : exec('sudo', ['-n', 'systemctl', 'restart', config.unit], config.source);
  const copy = (from, to, excludes) => exec(config.rsync,
    ['-a', ...excludes.map(value => `--exclude=${value}`), `${from}/`, `${to}/`], config.source);
  try {
    fs.mkdirSync(release, { recursive: true, mode: 0o700 });
    copy(config.source, release, EXCLUDES);
    const count = validateSyntax(release, config.node, exec);
    readJson(path.join(release, 'package.json'));
    readJson(path.join(release, 'package-lock.json'));
    let changed = true;
    try { changed = !previous || dependencyDigest(release) !== dependencyDigest(previous); } catch {}
    if (!changed && fs.existsSync(path.join(previous, 'node_modules'))) {
      fs.mkdirSync(path.join(release, 'node_modules'));
      copy(path.join(previous, 'node_modules'), path.join(release, 'node_modules'), []);
    } else {
      exec(config.npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', ...(config.installScripts ? [] : ['--ignore-scripts'])], release);
    }
    // Even an unchanged manifest must not promote missing or invalid packages.
    exec(config.npm, ['ls', '--omit=dev', '--depth=0'], release);
    fs.writeFileSync(path.join(release, '.deploy-release.json'), JSON.stringify({ id, preparedAt: new Date().toISOString() }) + '\n');
    if (backup) {
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      copy(previous, backup, EXCLUDES.filter(value => !['node_modules/', '.deploy-release.json'].includes(value)));
    }
    const result = { id, release, backup, previous, state: 'prepared', syntaxFiles: count };
    const record = () => fs.writeFileSync(path.join(config.state, `${id}.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    record();
    log(`Prepared ${id}; validated ${count} JavaScript files. Backup: ${backup || 'no previous deployment'}`);
    if (!config.activate) { log('Release prepared only; live files and running processes unchanged.'); return result; }

    const previousId = readJson(path.join(previous, '.deploy-release.json')).id;
    if (typeof previousId !== 'string' || !previousId || !await healthy(config, previousId, fetcher, sleep)) {
      throw new Error('Current release is not healthy or lacks a release marker; activation refused');
    }
    // Verify the configured service is active before changing the live pointer.
    if (config.scope === 'user') exec('systemctl', ['--user', 'is-active', '--quiet', config.unit], config.source);
    else exec('sudo', ['-n', 'systemctl', 'is-active', '--quiet', config.unit], config.source);
    if (fs.realpathSync(config.target) !== previous) throw new Error('Live release changed during preparation; activation refused');
    atomicLink(config.target, release); promoted = true;
    try {
      restart();
      if (!await healthy(config, id, fetcher, sleep)) throw new Error('New release failed its health check');
      result.state = 'active'; record(); log(`Activated and health-checked ${id}`);
      return result;
    } catch (error) {
      atomicLink(config.target, previous); promoted = false;
      result.state = 'rolled-back'; record();
      try {
        restart();
        if (!await healthy(config, previousId, fetcher, sleep)) throw new Error('Previous release failed its health check');
      } catch (rollbackError) {
        throw new Error(`Deployment failed; previous pointer restored but service recovery needs attention: ${rollbackError.message}`, { cause: error });
      }
      throw new Error(`Deployment failed and was rolled back: ${error.message}`, { cause: error });
    }
  } finally {
    // Release trees and backups are retained for diagnosis and manual recovery.
    if (promoted) log('Live release pointer retained.');
    fs.rmdirSync(lock);
  }
}

if (require.main === module) deploy(configuration()).catch(error => { console.error(`[deploy] ${error.message}`); process.exitCode = 1; });
module.exports = { configuration, deploy, validateSyntax };
