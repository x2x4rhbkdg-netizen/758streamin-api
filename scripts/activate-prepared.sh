#!/usr/bin/env bash
# Manual in-place activation for the existing standalone systemd service.
set -eu
umask 077

MODE=${1:---check}
if [ "$#" -gt 1 ]; then echo 'Usage: bash scripts/activate-prepared.sh [--check|--activate]'; exit 2; fi
case "$MODE" in
  --check|--activate) ;;
  --help) echo 'Usage: bash scripts/activate-prepared.sh [--check|--activate]'; exit 0 ;;
  *) echo 'Usage: bash scripts/activate-prepared.sh [--check|--activate]'; exit 2 ;;
esac

NODE=${DEPLOY_NODE_BIN:-/opt/cpanel/ea-nodejs20/bin/node}
CHECKOUT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
LIVE=${DEPLOY_TARGET:-/home/streamin758/standalone-api}
STATE=${DEPLOY_STATE:-$LIVE.deploy}
UNIT=${DEPLOY_SYSTEMD_UNIT:-758streamin-api.service}
HEALTH_URL=${DEPLOY_HEALTH_URL:-http://127.0.0.1:3001/health}
BACKUP="$STATE/backups/manual-$(date +%Y%m%d-%H%M%S)-$$"
LOCKED=0
ROLLBACK_NEEDED=0
PREVIOUS=''

sync_code() {
  rsync -ac --exclude=node_modules/ --exclude='.env*' --exclude='*.env' \
    --exclude=tmp/ --exclude=uploads/ --exclude=storage/ --exclude=data/ \
    --exclude=.git/ --exclude=.codex/ --exclude=.agents/ --exclude='*.log' "$@"
}

health_ok() {
  for attempt in $(seq 1 15); do
    if "$NODE" -e 'const u=new URL(process.argv[2]); if(u.protocol!=="http:" || !["127.0.0.1","[::1]"].includes(u.hostname) || u.username || u.password) process.exit(1); fetch(u,{signal:AbortSignal.timeout(3000),redirect:"error"}).then(async r=>{const d=await r.json();if(r.status!==200||d.ok!==true||d.service!=="758streamin API"||d.release!==process.argv[1])throw Error()}).catch(()=>process.exit(1))' "$1" "$HEALTH_URL"; then return 0; fi
    sleep 2
  done
  return 1
}

cleanup() {
  result=$?
  trap - EXIT
  if [ "$ROLLBACK_NEEDED" = 1 ]; then
    echo 'Update did not complete. Restoring previous files.'
    if sync_code --delete "$BACKUP/" "$LIVE/" && systemctl restart "$UNIT" && health_ok "$PREVIOUS"; then
      echo "Previous release restored and healthy: $PREVIOUS"
    else
      echo "RECOVERY NEEDS ATTENTION. Backup: $BACKUP" >&2
    fi
    result=1
  fi
  if [ "$LOCKED" = 1 ]; then rmdir "$STATE/lock" || result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

test -x "$NODE"
"$NODE" -e 'const u=new URL(process.argv[1]);if(u.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(u.hostname)||u.username||u.password)throw Error("Health URL must be direct HTTP loopback");' "$HEALTH_URL"
test -d "$LIVE" && test ! -L "$LIVE" || { echo 'Live target must be an ordinary directory.'; exit 1; }
test -d "$STATE"
"$NODE" -e 'if(require("node:fs").statSync(process.argv[1]).mode & 0o077)throw Error("Deployment state must have mode 700 to protect backups");' "$STATE"
if [ "$MODE" = --activate ]; then
  mkdir "$STATE/lock" || { echo 'Deployment lock exists. Stop and inspect it; do not remove an active lock.'; exit 1; }
  LOCKED=1
fi

RELEASE=$("$NODE" -e 'const {latestPrepared}=require(process.argv[1]);const p=latestPrepared(process.argv[2]);if(!p)throw Error("No completed prepared release found");console.log(p)' "$CHECKOUT/scripts/deploy-preflight.cjs" "$STATE")
echo "Selected release: $RELEASE"
test -d "$RELEASE/node_modules"

# Do not allow an environment override to overlap source, state and live trees.
"$NODE" -e 'const fs=require("node:fs"),p=require("node:path");const [source,live,state,release]=process.argv.slice(1).map(v=>fs.realpathSync(v));const nested=(a,b)=>a===b||a.startsWith(b+p.sep);if(nested(source,live)||nested(live,source)||nested(state,live)||nested(live,state)||nested(release,source))throw Error("Unsafe overlapping deployment paths");' "$CHECKOUT" "$LIVE" "$STATE" "$RELEASE"

diff -qr --exclude=tmp --exclude=uploads --exclude='*.log' "$CHECKOUT/src" "$RELEASE/src" || {
  echo 'Prepared source differs from checkout. Stop and review the differences.'; exit 1;
}
for file in package.json package-lock.json; do
  cmp -s "$CHECKOUT/$file" "$RELEASE/$file" || { echo 'Prepared dependency files differ from checkout. Deploy HEAD in cPanel first.'; exit 1; }
  cmp -s "$LIVE/$file" "$RELEASE/$file" || { echo 'Live dependency files differ. Stop and review before updating.'; exit 1; }
done

"$NODE" -e 'const {validateSyntax}=require(process.argv[1]);const {spawnSync}=require("node:child_process");const count=validateSyntax(process.argv[2],process.execPath,(cmd,args,cwd)=>{const r=spawnSync(cmd,args,{cwd,encoding:"utf8"});if(r.status!==0)throw Error(r.stderr||r.error?.message||"Syntax validation failed");});console.log(`Validated ${count} JavaScript files`);' "$CHECKOUT/scripts/deploy.cjs" "$RELEASE"

release_id() {
  "$NODE" -e 'const r=require(process.argv[1]);if(typeof r.id!=="string"||!r.id)process.exit(1);console.log(r.id)' "$1/.deploy-release.json"
}
EXPECTED=$(release_id "$RELEASE")
PREVIOUS=$(release_id "$LIVE")
systemctl is-active --quiet "$UNIT"
health_ok "$PREVIOUS" || { echo 'Current API failed its baseline health check. No update performed.'; exit 1; }

if [ "$EXPECTED" = "$PREVIOUS" ]; then
  echo "Release already active and healthy: $EXPECTED"; exit 0
fi
if [ "$MODE" = --check ]; then
  echo "Checks passed for $EXPECTED. No backup, file copy or restart performed."
  echo 'Run this script with --activate only when ready for a service restart.'
  exit 0
fi

echo "Activating $EXPECTED; the API will restart and playback may be interrupted."
mkdir -p "$STATE/backups"
test ! -e "$BACKUP"
cp -a "$LIVE" "$BACKUP"
chmod 700 "$BACKUP"
echo "Backup: $BACKUP"
ROLLBACK_NEEDED=1
if sync_code "$RELEASE/" "$LIVE/" && systemctl restart "$UNIT" && health_ok "$EXPECTED"; then
  ROLLBACK_NEEDED=0
  echo "New release is healthy: $EXPECTED"
else
  exit 1
fi
