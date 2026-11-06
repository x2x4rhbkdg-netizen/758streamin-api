# WHMCS status and database load: November 6, 2026

## Deployment

1. Back up the API database and deploy the API code.
2. Run `src/db/migrate.whmcs-status-jobs.mysql.sql` in the API database using
   phpMyAdmin's SQL tab. It creates only a small scheduler table; no device rows,
   IDs, history or favorites are altered by the migration.
3. Restart the API, then deploy/restart the dashboard. Existing WHMCS credentials
   are reused. `WHMCS_STATUS_INTERVAL_SECONDS` defaults to `300`, clamped to 60-3600.
4. For Passenger installations which idle/sleep, configure a once-per-minute cron
   invoking `node scripts/sync-whmcs-status.cjs` from the deployed API directory.
   Use the server's actual Node 20+ path and provide the same API environment
   securely. cPanel application environment variables are not automatically inherited
   by cron. Do not put secrets in the cron command, repository or public web root.
   `npm run sync:whmcs-status` is the equivalent manual command.

The timer and cron share a MySQL advisory lock and persistent due time, so multiple
Passenger workers do not each sync all services. A scan runs at most every five
minutes by default, checked on a one-minute tick. Normal propagation is roughly
5-6 minutes plus WHMCS response time and the dashboard's next 15-second poll.
API outages/idle periods require the cron for reliable scheduling. Missing migration
logs `ER_NO_SUCH_TABLE` and leaves normal API traffic running; do not treat it as a
successful status sync.

Check scheduler health without disclosing credentials:

```sql
SELECT job_name, next_run_at, last_success_at FROM api_background_jobs;
```

## Behavior preserved and changed

- Only previously activated, WHMCS-linked devices in `active` or `suspended` state
  participate automatically. Pending devices still require normal activation/manual
  sync. Unknown, missing, failed, Cancelled, Terminated and Pending service results
  leave device status unchanged; only confirmed Active/Suspended are mapped.
- One paginated GetClientsProducts scan serves all linked services; only statuses
  are retained. No per-device client-profile, credential, plan, notification or
  entitlement sync is performed by the lightweight worker. Full manual sync and
  the existing automation route still handle those fields, and now also map Suspended.
- Writes are grouped and conditional on changed status/billing status, rechecking
  the current service link and active/suspended state. Deleted or newly pending
  transfer records are not recreated/reactivated. Plans, Adult access, expiry,
  history, favorites and credentials are untouched by this worker.
- Dashboard device/online polls change from 2 seconds to 15 seconds: 30 to 4 requests
  per visible tab per minute. Playback labels refresh separately at most every 30
  seconds. Hidden tabs and overlapping device loads remain excluded.
- Full list GET no longer activates suspended trials merely because a due date is
  set. Existing local trial-expiry suspension remains in place. Lightweight polls
  include billing status so WHMCS updates require no full record reload.
- An analytics result no longer triggers another identical analytics load when
  `hasAnalyticsData` changes. Initial and explicit filter/auto-refresh loads remain.
- Device authorization is NOT cached: active/status, expiry, deletion and code
  checks still hit SQL on each authorized request. Non-heartbeat last-seen writes
  are bounded to one attempt per device/minute/worker, and heartbeat avoids that
  duplicate write. The existing four-second heartbeat remains for online accuracy;
  it updates `updated_at` only when model/version changes.
- Device profile/registration price lookups share concurrent requests and cache
  successful WHMCS prices for five minutes per service/worker (null/failure one
  minute), with a 15-second request timeout and exact service-ID matching.
- API-proxied playback context uses one joined device/access/upstream read instead
  of two sequential reads. It still verifies JWT and checks device status/expiry on
  every request, including each HLS asset request. No positive authorization cache.

## Streaming inspection: limits not changed

The API uses one MySQL pool (up to 10 connections per API process), not one database
connection per viewer. Passenger worker counts multiply that capacity. Do not raise
pool size without database/server measurements.

Live TV and Radio previews are only rendered while their screen is focused; opening
fullscreen unmounts the preview. The playback token cache already reuses tokens for
the same device/type/stream/episode when enough TTL remains. The normal player does
not refresh these on a periodic timer; reload/retry can request or resolve a source.
A token request alone does not open a media connection. Fresh-live requests can
intentionally bypass token reuse for recovery.

There is NO proven server-side one-playback-session-per-device enforcement in the
inspected routes. `max_streams` is read but not enforced as a distributed media
lease. `/playback/stream` redirects to the provider; movie/debrid and custom-playlist
sources can also play directly. Refreshing/revoking an API token does not terminate
an already-open direct upstream connection. External players are separate processes.
HLS legitimately uses multiple manifest, video, audio and subtitle HTTP requests;
that must not be confused with multiple active playback sessions.

No playback limit, token TTL, token identity, external-player flow or reconnect policy
was changed. A future hard limit needs provider-side max-connection enforcement or
an explicitly designed shared playback lease/proxy with stop/renew semantics and
physical-device tests. This work does not promise a hard one-connection limit.

## Verification and remaining checks

API unit/route tests use mocked databases and WHMCS responses. Dashboard browser
checks use mocked endpoints and clock control on desktop/mobile. Production build
checks do not prove live billing propagation, physical playback or CPU savings.
The production MySQL instance and provider sessions were not accessed or changed.
The recent-playback execution plan still needs the read-only EXPLAIN in
`DEVICE-PRESENCE-PERFORMANCE.md`; no speculative index or server tuning was applied.

Before rollout, validate a linked Active and Suspended device, a pending device,
unlinked/manual device, failed WHMCS response, deletion, code transfer, expiry and
trial/plan access in staging. Compare MySQL query counts and CPU with equal visible
dashboard tabs and active viewers. Keep prior API/dashboard release artifacts for
rollback; the additive job table can remain if application code is rolled back.

WHMCS request pagination follows the official GetClientsProducts API:
https://developers.whmcs.com/api-reference/getclientsproducts
