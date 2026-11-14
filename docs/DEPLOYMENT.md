# cPanel Deployment And Controlled Activation

## Current Default: Prepare Only

The cPanel task runs `node scripts/deploy.cjs` with the target
`/home/streamin758/standalone-api`. Node 20+ and npm must be available to cPanel's
deployment shell. It does not restart Passenger, change Apache, switch the live
directory, or restart a systemd service by default.

Each run creates a unique release under
`/home/streamin758/standalone-api.deploy/releases/` and:

1. Validates `.js`, `.cjs`, and `.mjs` files in the staged tree using `node --check`.
2. Parses the staged `package.json` and `package-lock.json`.
3. Compares both files to the current deployment. Changed manifests, a changed
   lockfile, or missing live dependencies trigger `npm ci --omit=dev`. Otherwise,
   a separate copy of the current dependencies is used, with no shared writable
   dependency tree between releases.
4. Runs `npm ls --omit=dev --depth=0` against the staged release. Failed installs or
   checks stop preparation; missing packages are never activated.
5. Backs up the existing deployed code, release marker, and dependencies under
   `standalone-api.deploy/backups/`. A deployment JSON record reports release,
   backup, previous path, syntax-file count, and prepared/active/rolled-back state.

Secrets (`.env`/`.env.*`), `.git`, logs, uploads, and `tmp` runtime data are excluded
from release copies and backups. Dependency installs disable lifecycle scripts by
default. Dependencies requiring native builds or install scripts must be reviewed
before opting into `DEPLOY_ALLOW_INSTALL_SCRIPTS=1`. Audit/funding requests are not
run during installation; this is dependency integrity/presence validation, not a
vulnerability audit.

Deployment state is restricted to the deploying user. Backups and release trees
are retained; plan disk capacity and manual retention. Do not delete the live
release, the rollback release, or releases still needed by running processes.
Failures retain prepared artifacts for diagnosis and release the deployment lock.
A machine crash may leave a stale `standalone-api.deploy/lock` directory; verify
that no deployment is running before removing that lock manually.

**Prepared does not mean active.** Unlike the former in-place rsync task, this
default leaves even the existing on-disk deployment unchanged. This avoids changing
files a running process might load lazily. The existing service continues using
its original code and in-memory playback cache.

## Manual Activation Of The Existing Directory

For the current ordinary-directory layout, the reusable activation script is
`scripts/activate-prepared.sh`. It is separate from cPanel's prepare-only task;
no automatic activation or Passenger/Apache change has been enabled. It requires
Bash, rsync, systemctl and Node 20, and should be run as root in the server session.

After **Update from Remote**, confirm the expected commit and use **Deploy HEAD
Commit** in cPanel to prepare a release. Then check it without copying live files,
creating a backup/lock, or restarting:

```bash
bash /home/streamin758/repos/api/scripts/activate-prepared.sh --check
```

When ready for a restart, activate with one command:

```bash
bash /home/streamin758/repos/api/scripts/activate-prepared.sh --activate
```

The default without arguments is `--check`. The script does not git-pull, prepare
a release, install dependencies, run migrations or configure a logging secret.
No chmod or executable bit is needed when invoking it through Bash. Use the file
from the checkout rather than copying a chat-formatted shell block.

Activation selects the latest completed prepared record and checks its marker,
source tree against the checkout (excluding tmp, uploads and logs), both dependency
files against checkout and live, all prepared JavaScript syntax, and the current
service/health release identity. It refuses symlink live targets, unsafe path
overlap, non-loopback health URLs and state storage with group/world permissions.
An existing deployment lock is never removed automatically. Runtime differences
are excluded, not deleted from the checkout.

The activation makes a full protected backup, copies code using checksum-based
rsync while retaining live secrets/runtime/modules, restarts the system-level
service and requires the new release ID from `/health`. Failure after copying
starts, including a handled INT/TERM/HUP, attempts a restore, restart and previous
release health check. Failed recovery retains the backup and reports that manual
attention is required. SIGKILL, power loss and machine failure cannot be trapped;
keep the printed backup path and inspect any stale lock before removing it.

Manual backups include secrets: deployment state must be mode 700, each backup
is restricted and retained, and storage/retention remain an operator duty. This
differs from cPanel's preparation backups, which exclude environment files.
The manual script deliberately refuses dependency-file changes; use a separately
reviewed dependency-aware deployment for those changes. It does not migrate the
directory into a managed-release symlink or provide zero-downtime deployment.

**Activation restarts the API and may interrupt customers watching.** Health
checks verify API readiness and release identity, not movie/live playback. Check
both after activation. The script prints a no-op message without restarting if
the selected release ID is already active and healthy.

Server defaults can be overridden explicitly with `DEPLOY_NODE_BIN`,
`DEPLOY_TARGET`, `DEPLOY_STATE`, `DEPLOY_SYSTEMD_UNIT` and `DEPLOY_HEALTH_URL`;
the checkout is derived from the script's own location, not the shell's current
directory. These settings are for operators, not client request inputs.

Local fixture tests (fake service and health probes, real cp/rsync) run with:

```bash
node --test scripts/activate-prepared.test.cjs
```

These tests do not execute production commands or prove production recovery.

## Readiness Endpoint

`GET /health` returns HTTP 200 only after a database `SELECT 1` succeeds. It reports
`ok`, service name, and the release ID captured when the app starts. Failure or a
two-second readiness timeout returns 503 without database details. Responses are
non-cacheable. The readiness timer bounds the HTTP response, not cancellation of
an in-flight SQL query; normal managed-pool acquisition limits still apply.

The deployment probe checks the direct loopback listener and requires the exact
new release ID. An old process, a stale proxy response, a redirect, or an unhealthy
database cannot be mistaken for successful activation. Source checkouts without
a deployment marker report `release: null`.

## One-Time Standalone Service Setup

### Read-Only Preflight

Before planning that setup, run from the API checkout on the server:

```sh
npm run deploy:preflight
```

This selects the newest completed **prepared** deployment record whose release
directory and marker agree. Incomplete releases, active/rolled-back records, and
records pointing outside release storage are ignored. To inspect a specific tree:

```sh
npm run deploy:preflight -- --release /path/to/prepared-release
npm run deploy:preflight -- --json
```

The preflight defaults reflect the server settings supplied in the screenshots:

```text
DEPLOY_HEALTH_URL=http://127.0.0.1:3001/health
DEPLOY_SYSTEMD_UNIT=758streamin-api.service
DEPLOY_SYSTEMD_SCOPE=system
```

Those are configuration inputs, not proof of the running server state. They do
not change the deploy script's defaults or enable activation. Keep these values
explicit when configuring future activation as well. Target/state paths use
`DEPLOY_TARGET` and `DEPLOY_STATE`; `DEPLOY_PREFLIGHT_RELEASE` is an alternative
to `--release`.

The command inspects:

- The current directory/symlink layout and live/candidate release markers.
- Direct loopback `/health` status and exact identity of the loaded release.
- Read-only `systemctl show` properties for the selected unit, including PID,
  working directory, active state, and systemd stop timeout. No sudo is invoked.
- Only the selected process-environment fields: `DISABLE_BACKGROUND_JOBS`, upload
  directories, `PORT`, `IP`, and `USE_DOTENV`. Other values are discarded from the
  report. If `/proc/PID/environ` is unreadable, the environment is marked unknown.
- Environment-file **names only** and runtime-directory names. It never opens
  `.env`/`.env.*` or `*.env` contents, nor walks runtime data, logs or dependencies.
- Live-only, candidate-only, and changed files. It hashes regular files within
  bounded limits, never follows descendant source-tree symlinks, and reports
  unreadable/unchecked paths rather than treating them as equal.
- Changes in database/configuration/job files and source-level background-job
  gates. It reports the shutdown deadline as a source observation, not proof that
  existing streams have drained. Static checks do not establish job ownership.

`storage/` and `data/` are inventoried as runtime directories even though the
deployment script does not exclude those names. Both still need explicit review
if they contain live data absent from the prepared release. Upload-path checks
only confirm an existing external directory; they do not prove the service user
can write it or that the candidate uses the same environment.

Scans are limited to 5,000 entries per tree, 8 MiB per hashed file, and 128 MiB of
hash input overall. Difference samples contain up to 60 paths per category with
separate total counts. Limits or unverified common symlinks cause an incomplete-
comparison blocker; no complete audit is claimed when evidence is missing.

The command never imports the app, loads environment files, runs migrations,
creates a release/backup/lock, starts API workers, or changes systemd/Apache. It
does invoke the read-only systemctl client and issue bounded HTTP GETs to the
configured local `/health` endpoint. These health requests perform the endpoint's
normal database `SELECT 1`. Error bodies and arbitrary health-response fields are
not printed.

For a candidate already running on a separately configured listener, optionally
set `DEPLOY_PREFLIGHT_CANDIDATE_HEALTH_URL=http://127.0.0.1:3002/health`. The command
will check it against the candidate marker; it will **not** start that instance.
Its job-disable flag and environment must be configured/verified separately from
the main service. Unset configuration keeps candidate runtime health unverified.

Exit codes:

- `0`: no blocking finding, but manual migration/traffic-drain review still needed.
- `2`: inspection completed with migration blockers. This is expected while the
  live path is an ordinary directory or its marker/health endpoint is absent.
- `1`: the audit could not complete because of invalid input or another error.

No result grants activation approval. Viewer continuity, old UUID cache owners,
proxy routing, restart privileges, job ownership, and actual server rollback must
still be established independently. Verify a stable filesystem snapshot if files
are changing during the audit; this read-only command deliberately takes no lock.

Test the preflight locally with `npm run test:preflight`.

Automatic activation requires the live target to be an existing symlink to a
release directory. The script refuses to rename/replace the current ordinary
directory automatically. That initial conversion must be planned separately,
after the legacy Passenger migration requirements in `HLS-PROCESS-VALIDATION.md`
have been satisfied. No conversion has been performed by these changes.

During that approved setup:

- Provision the service environment outside the release trees. Keep JWT and
  credential-encryption keys consistent with the intended service. Do not depend
  on a release-local `.env`, because those files are deliberately excluded.
- Configure persistent `HOME_AD_UPLOAD_DIR` and `NOTIFICATION_IMAGE_UPLOAD_DIR`
  outside releases; keep any other writable application data outside immutable
  release directories as well.
- Configure systemd's working directory to resolve through the live symlink and
  its executable to the intended Node 20+ installation. Specify a private
  loopback listener. Never point activation at Passenger's service or Apache.
- Seed the first live symlink from a validated prepared release, then verify that
  service's `/health` returns the release ID from its `.deploy-release.json`.
  This is a separate maintenance operation, not a step the cPanel task performs.
- Keep background-job ownership explicit. A validation/secondary standalone
  process should have `DISABLE_BACKGROUND_JOBS=1` while the existing service owns
  those jobs. Verify the MariaDB connection budget for the intended worker count.
- Grant the deploying user access to its user systemd service, or narrowly scoped
  non-interactive sudo access to `systemctl is-active` and `restart` for exactly
  the approved system service. The script never installs privilege rules.

## Opt-In Activation And Rollback

After setup and an approved restart window, invoke from the deployment checkout:

```sh
DEPLOY_TARGET=/home/streamin758/standalone-api \
DEPLOY_ACTIVATE=1 \
DEPLOY_ALLOW_RESTART=1 \
DEPLOY_SYSTEMD_UNIT=758streamin-api.service \
DEPLOY_SYSTEMD_SCOPE=system \
DEPLOY_HEALTH_URL=http://127.0.0.1:3001/health \
node scripts/deploy.cjs
```

The unit name, scope and port above reflect the supplied screenshots; run the
read-only preflight to verify them against the server before planning activation.
The cPanel YAML intentionally does not set the activation/restart flags. Use
`DEPLOY_SYSTEMD_SCOPE=system` only for an approved system service; this uses
`sudo -n systemctl` and will fail instead of prompting for a password.

Activation requires both opt-ins, an existing release symlink, a healthy current
release with an ID, and an active configured systemd service. A lock serializes
deployment commands. The script prepares the new tree and backup first, atomically
switches the symlink, restarts only that unit, and probes health up to ten times
with three-second request timeouts and one-second intervals.

If restart or health fails, it atomically restores the previous symlink, restarts
the same unit, verifies the previous release ID, records rollback, and exits
nonzero so cPanel reports the failed deployment. If recovery also fails, the
error explicitly calls for operator attention. No database schema migrations are
run or rolled back. Old dependencies and secrets are not overwritten.

Rollback does not recreate lost in-memory caches, restore already disconnected
viewers, or ensure zero downtime. Retain the Passenger-owner/drain strategy before
allowing any restart affecting active UUID-based HLS sessions.

Optional path overrides are `DEPLOY_STATE`, `DEPLOY_NODE_BIN`, `DEPLOY_NPM_BIN`, and
`DEPLOY_RSYNC_BIN`. Keep state outside both the source checkout and live directory.

## Local Verification

```sh
npm run test:deploy
npm test
```

Deployment tests use temporary directories, real syntax checks and rsync, with
simulated npm/systemd outcomes and health responses. A separate smoke test also
runs real npm against a dependency-free fixture and verifies that lifecycle
scripts stay disabled. The tests verify preparation-only
behavior, backups, dependency-change handling, activation gates, failed checks,
stale-release detection, restart failure, rollback, and recovery failure. Readiness
handler tests cover healthy, failed, and stalled SQL. Actual Linux/cPanel/systemd
validation remains a server setup task; local tests never restart a real service.
