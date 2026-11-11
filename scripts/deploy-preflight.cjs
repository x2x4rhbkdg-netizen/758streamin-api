"use strict";

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ENV_KEYS = ['DISABLE_BACKGROUND_JOBS', 'HOME_AD_UPLOAD_DIR', 'NOTIFICATION_IMAGE_UPLOAD_DIR',
  'PORT', 'IP', 'USE_DOTENV'];
const SKIP = new Set(['.git', 'node_modules', '.codex', '.agents']);
const RUNTIME = new Set(['tmp', 'uploads', 'storage', 'data']);
const secretName = name => /^\.env(?:\.|$)/.test(name) || /\.env$/.test(name);
const kind = stat => stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special';
const stat = filename => { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;

// Bounded, no-follow reads are only used for metadata, selected source files and
// /proc environment filtering. Environment-file contents are never opened.
function readSmall(filename, limit = 128 * 1024) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0, count;
    while (length <= limit && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > limit) throw new Error('Read limit exceeded');
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function marker(directory) {
  try { return safeId(JSON.parse(readSmall(path.join(directory, '.deploy-release.json'), 16384)).id); }
  catch { return null; }
}

function configuration(env = process.env, args = process.argv.slice(2)) {
  const config = {
    target: path.resolve(env.DEPLOY_TARGET || '/home/streamin758/standalone-api'),
    release: env.DEPLOY_PREFLIGHT_RELEASE ? path.resolve(env.DEPLOY_PREFLIGHT_RELEASE) : null,
    healthUrl: env.DEPLOY_HEALTH_URL || 'http://127.0.0.1:3001/health',
    candidateHealthUrl: env.DEPLOY_PREFLIGHT_CANDIDATE_HEALTH_URL || null,
    unit: env.DEPLOY_SYSTEMD_UNIT || '758streamin-api.service', scope: env.DEPLOY_SYSTEMD_SCOPE || 'system',
    procRoot: '/proc', maxEntries: 5000, maxFileBytes: 8 * 1024 * 1024,
    maxHashBytes: 128 * 1024 * 1024, sampleLimit: 60, json: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') config.json = true;
    else if (args[i] === '--release' && args[i + 1] && !args[i + 1].startsWith('--')) config.release = path.resolve(args[++i]);
    else throw new Error('Usage: npm run deploy:preflight -- [--release /absolute/release/path] [--json]');
  }
  config.state = path.resolve(env.DEPLOY_STATE || `${config.target}.deploy`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_@.-]*\.service$/.test(config.unit) || !['system', 'user'].includes(config.scope)) {
    throw new Error('Invalid systemd unit or scope');
  }
  for (const value of [config.healthUrl, config.candidateHealthUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/health' || url.search || url.hash) {
      throw new Error('Preflight probes must use an HTTP loopback /health URL without credentials or query parameters');
    }
  }
  return config;
}

function latestPrepared(state) {
  const releases = path.join(state, 'releases') + path.sep;
  let files;
  try { files = fs.readdirSync(state).filter(name => name.endsWith('.json')).sort().reverse(); }
  catch { return null; }
  for (const name of files) {
    try {
      const record = JSON.parse(readSmall(path.join(state, name), 16384));
      if (record.state !== 'prepared' || typeof record.release !== 'string') continue;
      const candidate = fs.realpathSync(record.release);
      const releaseRoot = fs.realpathSync(path.join(state, 'releases')) + path.sep;
      if (!path.resolve(record.release).startsWith(releases) || !candidate.startsWith(releaseRoot)) continue;
      if (safeId(record.id) && marker(candidate) === record.id) return candidate;
    } catch {}
  }
  return null;
}

function inventory(root, config) {
  const entries = new Map(), runtime = [], environmentFiles = [], errors = [];
  let count = 0, truncated = false;
  const visit = relative => {
    let children;
    try { children = fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { errors.push(relative || '.'); return; }
    for (const child of children) {
      if (++count > config.maxEntries) { truncated = true; return; }
      const name = path.join(relative, child.name);
      if (SKIP.has(child.name) || child.name === '.deploy-release.json') continue;
      if (secretName(child.name)) { environmentFiles.push(name); continue; }
      let info;
      try { info = fs.lstatSync(path.join(root, name)); }
      catch { errors.push(name); continue; }
      if (RUNTIME.has(child.name) && (info.isDirectory() || info.isSymbolicLink())) {
        runtime.push({ path: name, kind: kind(info), excludedByDeployment: ['tmp', 'uploads'].includes(child.name) });
        continue;
      }
      if (child.name.endsWith('.log')) continue;
      entries.set(name, { kind: kind(info), size: info.size });
      // Descendant symlinks are recorded but never followed.
      if (info.isDirectory()) visit(name);
      if (truncated) return;
    }
  };
  visit('');
  return { entries, runtime, environmentFiles, errors, truncated };
}

async function hashFile(filename, config, budget) {
  const hash = createHash('sha256');
  let size = 0;
  const stream = fs.createReadStream(filename, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  try {
    for await (const chunk of stream) {
      size += chunk.length; budget.bytes -= chunk.length;
      if (size > config.maxFileBytes || budget.bytes < 0) return null;
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch { return null; }
  finally { stream.destroy(); }
}

async function compare(live, release, before, after, config) {
  const changes = { onlyLive: [], onlyRelease: [], changed: [], unchecked: [] };
  const budget = { bytes: config.maxHashBytes };
  for (const [name, info] of before.entries) {
    const other = after.entries.get(name);
    if (!other) { changes.onlyLive.push(name); continue; }
    if (info.kind !== other.kind) { changes.changed.push(name); continue; }
    if (info.kind === 'directory') continue;
    if (info.kind !== 'file') { changes.unchecked.push(name); continue; }
    if (info.size !== other.size) { changes.changed.push(name); continue; }
    if (info.size > config.maxFileBytes || budget.bytes <= 0) { changes.unchecked.push(name); continue; }
    const a = await hashFile(path.join(live, name), config, budget);
    const b = a === null ? null : await hashFile(path.join(release, name), config, budget);
    if (a === null || b === null) changes.unchecked.push(name);
    else if (a !== b) changes.changed.push(name);
  }
  for (const name of after.entries.keys()) if (!before.entries.has(name)) changes.onlyRelease.push(name);
  return { ...changes, bytesHashed: config.maxHashBytes - budget.bytes };
}

function sourceFacts(root) {
  let app, server;
  try {
    if (!stat(path.join(root, 'src'))?.isDirectory()) return { readable: false };
    app = readSmall(path.join(root, 'src/app.js')); server = readSmall(path.join(root, 'src/server.js'));
  }
  catch { return { readable: false }; }
  const code = app.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  const shutdownIndex = server.indexOf('let shuttingDown');
  const shutdown = shutdownIndex >= 0 ? server.slice(shutdownIndex) : '';
  const deadline = /setTimeout\(\s*\(\)\s*=>\s*process\.exit\(1\),\s*(\d+)\s*\)/.exec(shutdown);
  return { readable: true,
    healthRoute: /app\.get\(["']\/health["']/.test(code),
    backgroundDisableGate: /process\.env\.DISABLE_BACKGROUND_JOBS\s*!==\s*["']1["']/.test(code),
    whmcsSyncPresent: /createWhmcsStatusSync/.test(code),
    transferCleanupPresent: /startDeviceTransferCleanup/.test(code),
    shutdownDeadlineMs: deadline ? Number(deadline[1]) : null,
  };
}

function serviceStatus(config, inspect) {
  const properties = ['ActiveState', 'SubState', 'MainPID', 'User', 'WorkingDirectory', 'TimeoutStopUSec'];
  const result = inspect('systemctl', [config.scope === 'user' ? '--user' : '--system', 'show', '--no-pager',
    config.unit, ...properties.map(name => `--property=${name}`)], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) return { readable: false, unit: config.unit, scope: config.scope };
  const fields = {};
  for (const line of result.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (properties.includes(line.slice(0, index))) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  let environment = null;
  if (/^[1-9]\d*$/.test(fields.MainPID || '')) {
    try {
      environment = {};
      const raw = readSmall(path.join(config.procRoot, fields.MainPID, 'environ'));
      for (const item of raw.split('\0')) {
        const index = item.indexOf('='), key = item.slice(0, index);
        if (ENV_KEYS.includes(key)) environment[key] = item.slice(index + 1);
      }
    } catch { environment = null; }
  }
  return { readable: true, unit: config.unit, scope: config.scope, ...fields,
    environmentReadable: environment !== null, environment,
    disableBackgroundJobs: environment === null ? null : environment.DISABLE_BACKGROUND_JOBS === '1' };
}

async function probe(url, expected, fetcher) {
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) return { status: response.status, healthy: false, release: null, releaseMatches: false };
    let text = '', size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) return { healthy: false, problem: 'response-too-large' };
      text += Buffer.from(chunk).toString('utf8');
    }
    const body = JSON.parse(text), release = safeId(body.release);
    const healthy = body.ok === true && body.service === '758streamin API';
    return { status: 200, healthy, release: release === expected ? release : null,
      releaseMatches: Boolean(expected && release === expected) };
  } catch { return { healthy: false, releaseMatches: false, problem: 'unreachable-or-invalid-response' }; }
}

async function preflight(config, { inspect = spawnSync, fetcher = fetch } = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  const report = { readOnly: true, activationAttempted: false, backgroundJobOwnershipVerified: false,
    target: config.target, stateDirectory: config.state,
    candidate: config.release || latestPrepared(config.state), healthUrl: config.healthUrl,
    candidateHealthUrl: config.candidateHealthUrl, findings };
  let live = null, candidate = null;
  try {
    const entry = stat(config.target);
    report.liveLayout = entry ? kind(entry) : 'missing';
    if (entry) live = fs.realpathSync(config.target);
    if (report.liveLayout !== 'symlink') add('block', 'LIVE_NOT_MANAGED', 'The live path is not a release symlink. One-time migration is still required.');
    if (live && !fs.statSync(live).isDirectory()) live = null;
  } catch { add('block', 'LIVE_UNREADABLE', 'The live deployment cannot be inspected.'); }
  if (!live) add('block', 'LIVE_MISSING', 'No readable live deployment directory was found.');
  if (report.candidate) {
    try { candidate = fs.realpathSync(report.candidate); if (!fs.statSync(candidate).isDirectory()) candidate = null; } catch {}
  }
  if (!candidate) add('block', 'CANDIDATE_MISSING', 'No complete prepared release was found. Pass --release with its path.');
  if (live && candidate && live === candidate) add('block', 'SAME_RELEASE', 'The candidate and live directory are the same; select a separate prepared release.');
  report.liveReleaseId = live ? marker(live) : null;
  report.candidateReleaseId = candidate ? marker(candidate) : null;
  if (!report.liveReleaseId) add('block', 'LIVE_MARKER_MISSING', 'The current release lacks a valid managed-release marker.');
  if (!report.candidateReleaseId) add('block', 'CANDIDATE_MARKER_MISSING', 'The candidate lacks a valid managed-release marker.');
  if (report.liveReleaseId && report.liveReleaseId === report.candidateReleaseId) add('block', 'DUPLICATE_RELEASE_ID', 'Live and candidate have the same release ID, so health checks cannot distinguish them.');

  report.service = serviceStatus(config, inspect);
  if (!report.service.readable) add('block', 'SERVICE_UNKNOWN', 'systemd status could not be read. No sudo or service-changing command was attempted.');
  else if (report.service.ActiveState !== 'active') add('block', 'SERVICE_NOT_ACTIVE', 'The configured systemd service is not active.');
  if (!report.service.environmentReadable) add('review', 'ENVIRONMENT_UNKNOWN', 'Running-process environment is unreadable. Verify job ownership and persistent upload paths separately.');
  report.liveHealth = await probe(config.healthUrl, report.liveReleaseId, fetcher);
  if (!report.liveHealth.healthy || !report.liveHealth.releaseMatches) add('block', 'BASELINE_NOT_HEALTHY', 'The live /health response is unavailable, unhealthy, or does not match its release marker.');
  if (config.candidateHealthUrl) {
    report.candidateHealth = await probe(config.candidateHealthUrl, report.candidateReleaseId, fetcher);
    if (!report.candidateHealth.healthy || !report.candidateHealth.releaseMatches) add('block', 'CANDIDATE_NOT_HEALTHY', 'The already-running candidate listener did not return its expected healthy release.');
  } else add('review', 'CANDIDATE_NOT_RUNNING', 'Candidate runtime health was not tested. This command never starts an API process.');

  report.liveSource = live ? sourceFacts(live) : null;
  report.candidateSource = candidate ? sourceFacts(candidate) : null;
  if (candidate && !report.candidateSource?.healthRoute) add('block', 'CANDIDATE_HEALTH_ROUTE_UNKNOWN', 'A /health route could not be confirmed in candidate source. No application code was loaded to infer behavior.');
  if (report.candidateSource?.backgroundDisableGate) add('review', 'JOB_OWNERSHIP', 'The candidate enables background jobs unless DISABLE_BACKGROUND_JOBS=1. A parallel validation instance must have a confirmed job-ownership plan.');
  if (report.candidateSource?.shutdownDeadlineMs) add('review', 'SHUTDOWN_DEADLINE', `Candidate SIGTERM shutdown has a ${report.candidateSource.shutdownDeadlineMs} ms deadline. This does not prove active streams are drained.`);
  if (report.service.environment?.PORT && Number(new URL(config.healthUrl).port || 80) !== Number(report.service.environment.PORT)) {
    add('block', 'PORT_MISMATCH', 'The configured health URL port differs from the running process PORT.');
  }
  report.uploadPaths = {};
  let releaseStorage = path.join(config.state, 'releases');
  try { releaseStorage = fs.realpathSync(releaseStorage); } catch {}
  for (const name of ['HOME_AD_UPLOAD_DIR', 'NOTIFICATION_IMAGE_UPLOAD_DIR']) {
    const value = report.service.environment?.[name];
    if (!value) {
      report.uploadPaths[name] = { configured: false, verified: false };
      continue;
    }
    let resolved = null;
    try { resolved = fs.realpathSync(value); } catch {}
    const inside = (base, target) => base && target && (target === base || target.startsWith(base + path.sep));
    const persistent = path.isAbsolute(value) && resolved && fs.statSync(resolved).isDirectory() &&
      !inside(live, resolved) && !inside(candidate, resolved) && !inside(releaseStorage, resolved);
    report.uploadPaths[name] = { configured: true, path: value, verified: Boolean(persistent) };
    if (!persistent) add('block', 'UPLOAD_PATH_NOT_PERSISTENT', `${name} is missing, relative, or resolves inside a release tree. Confirm an existing external directory before migration.`);
  }
  if (Object.values(report.uploadPaths).some(item => !item.configured)) {
    add('review', 'UPLOAD_PATHS_UNKNOWN', 'External upload directories could not be confirmed from the running environment. Check both settings for the new service; unset settings use release-local defaults.');
  }
  if (live && candidate) {
    const before = inventory(live, config), after = inventory(candidate, config);
    report.runtimeDirectories = { live: before.runtime, candidate: after.runtime };
    report.environmentFiles = { live: before.environmentFiles, candidate: after.environmentFiles };
    if (before.runtime.length || before.environmentFiles.length) add('review', 'RUNTIME_DATA', 'Live runtime directories or environment files exist. Confirm external persistence before switching releases; their contents were not read.');
    const changes = await compare(live, candidate, before, after, config);
    report.differences = { counts: {}, samples: {}, bytesHashed: changes.bytesHashed };
    for (const key of ['onlyLive', 'onlyRelease', 'changed', 'unchecked']) {
      report.differences.counts[key] = changes[key].length;
      report.differences.samples[key] = changes[key].slice(0, config.sampleLimit);
    }
    report.behaviorChanges = [...new Set([...changes.changed, ...changes.onlyRelease, ...changes.onlyLive])]
      .filter(name => /^(?:src\/db\/.*|src\/utils\/(?:whmcsStatusSync|deviceTransferCleanup)\.cjs|src\/app\.js|src\/config\/env\.cjs)$/.test(name));
    if (report.behaviorChanges.length) add('review', 'DATABASE_OR_JOB_CHANGES', 'Database, app initialization, or background-job files differ. Review these paths; no application code or migration was executed.');
    if (changes.onlyLive.length) add('review', 'LIVE_ONLY_FILES', 'The live deployment contains files absent from the candidate. Check the reported paths before migration.');
    if (before.truncated || after.truncated || before.errors.length || after.errors.length || changes.unchecked.length) {
      add('block', 'INCOMPLETE_COMPARISON', 'Some paths could not be compared because of symlinks, permissions or scan limits. Resolve them before migration.');
    }
    report.scan = { truncated: before.truncated || after.truncated, unreadablePaths: [...before.errors, ...after.errors] };
  }
  add('review', 'TRAFFIC_DRAIN_UNVERIFIED', 'This audit does not verify active viewers, legacy UUID cache ownership, Apache routing, sudo privileges, or rollback on the server. Keep activation disabled pending that validation.');
  report.blockerCount = findings.filter(item => item.level === 'block').length;
  report.status = report.blockerCount ? 'blocked' : 'manual-review-required';
  return report;
}

function printReport(report) {
  console.log('Read-only deployment preflight: ' + report.status);
  console.log(JSON.stringify({ target: report.target, candidate: report.candidate, liveLayout: report.liveLayout,
    liveReleaseId: report.liveReleaseId, candidateReleaseId: report.candidateReleaseId, service: report.service,
    liveHealth: report.liveHealth, candidateHealth: report.candidateHealth, runtimeDirectories: report.runtimeDirectories,
    environmentFiles: report.environmentFiles, uploadPaths: report.uploadPaths, differences: report.differences, behaviorChanges: report.behaviorChanges,
    liveSource: report.liveSource, candidateSource: report.candidateSource, scan: report.scan }, null, 2));
  for (const item of report.findings) console.log(`[${item.level.toUpperCase()}] ${item.code}: ${item.message}`);
  console.log('No deployment files changed, app code imported, API workers started, or services restarted.');
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const config = configuration();
    const report = await preflight(config);
    if (config.json) console.log(JSON.stringify(report, null, 2)); else printReport(report);
    process.exitCode = report.blockerCount ? 2 : 0;
  }).catch(() => { console.error('Preflight could not complete. Check arguments and read permissions; no changes were made.'); process.exitCode = 1; });
}

module.exports = { configuration, preflight, latestPrepared };
