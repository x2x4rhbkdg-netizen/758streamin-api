# Device-list database load

Deploy the API before the dashboard. The November 6 status worker requires
`src/db/migrate.whmcs-status-jobs.mysql.sql`; see `WHMCS-STATUS-PERFORMANCE.md`.

- `GET /v1/admin/devices` preserves the full list, authorization and playback labels.
- `GET /v1/admin/devices?presence=1` returns only ID, code, status, last-seen and online.
  It performs one devices SELECT, with the same admin ownership scope, no joins,
  no sorting, no analytics query and no name resolution.
- Add `&playback=1` to refresh playback metadata. The dashboard polls every 15 seconds,
  including playback at most once every 30 seconds.
- Full loads occur on initial load, manual/selected auto-refresh, existing mutation
  flows, and discovery of a new device or changed device code. Presence snapshots
  remove deleted or no-longer-visible rows without recreating them.
- Polling pauses in hidden tabs, does not overlap itself or full loads, and ignores
  responses superseded by edits/full loads. Failed polls retain existing data.
- Presence requests never perform trial/billing reconciliation. Full list requests
  retain trial expiry suspension, but never reactivate devices based only on a due
  date. WHMCS status is checked by the server worker. Device JWT, deletion and expiry
  checks remain per request.

## Production execution-plan check

There is no local MySQL instance or production database connection available in this
workspace. No production EXPLAIN or index change has been executed. The recent
playback predicate now compares the indexed column directly to a time boundary
instead of applying TIMESTAMPDIFF to every row. Confirm its plan with production
statistics before adding an index or claiming a measured performance improvement.

Run the following read-only statements in administrator phpMyAdmin with the
StreamIN database selected. Replace the sample ID list with actual online device
IDs from the dashboard; use the same list for both plans.

```sql
SHOW INDEX FROM analytics_events;

EXPLAIN FORMAT=JSON
SELECT ae.id, ae.device_id, ae.content_id, ae.content_type,
       ae.meta_json, ae.created_at, ae.event_type
FROM analytics_events ae
WHERE ae.device_id IN (1, 2, 3)
  AND ae.content_id IS NOT NULL
  AND ae.event_type IN ('play', 'time_watched')
  AND TIMESTAMPDIFF(SECOND, ae.created_at, NOW()) <= 120
ORDER BY ae.device_id ASC, ae.created_at DESC, ae.id DESC;

EXPLAIN FORMAT=JSON
SELECT ae.id, ae.device_id, ae.content_id, ae.content_type,
       ae.meta_json, ae.created_at, ae.event_type
FROM analytics_events ae
WHERE ae.device_id IN (1, 2, 3)
  AND ae.content_id IS NOT NULL
  AND ae.event_type IN ('play', 'time_watched')
  AND ae.created_at >= DATE_SUB(NOW(), INTERVAL 120 SECOND)
ORDER BY ae.device_id ASC, ae.created_at DESC, ae.id DESC;
```

Compare the selected key, used key parts, estimated rows examined and sorting.
The repository's base schema has separate device_id and event_type indexes, but
production may differ. A candidate `(device_id, created_at, id)` index needs a
production-plan review and write/storage cost assessment first; do not add a
duplicate or assume it is optimal. EXPLAIN ANALYZE actually executes the query;
the above plain EXPLAIN statements only request estimates.

Validate before/after using equal measurement windows, dashboard tab counts and
online-device counts. Test Off/manual refresh, remote deletion, code transfer,
reseller scope, expired sessions and background/foreground behavior. CPU savings
have not been measured on the live server.
