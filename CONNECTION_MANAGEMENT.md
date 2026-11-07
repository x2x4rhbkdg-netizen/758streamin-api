# MySQL connection management

One shared mysql2 pool per Node worker remains capped at 10 connections. Normal
queries and explicit transactions return connections to that pool. Video playback
limits and per-request authorization/device deletion checks are unchanged.

## Deployment

Deploy/restart the API first, then publish the updated Android app when ready.
No database migration or dashboard rebuild is needed for these changes.

Optional Passenger environment variables:

- `DB_POOL_QUEUE_LIMIT=100`: bounded waiting queue per worker (1-1000).
- `DB_POOL_ACQUIRE_TIMEOUT_MS=5000`: checkout deadline (100-30000 ms).
- `DEVICE_ONLINE_WINDOW_SECONDS=45`: default online-presence window.
- `WHMCS_STATUS_INTERVAL_SECONDS=300`: existing five-minute sync interval.

Existing explicit online-window overrides are respected. If currently set to 8,
change it to 45 to enable 15-second heartbeats in updated apps. Older apps keep
their existing four-second cadence; newer apps also use four seconds against an
older API. The API advertises a slower interval only in its heartbeat response;
the client validates it against the online window. A suspended/deleted device is
still denied on the next authenticated request, including each heartbeat. An idle
foreground app may now take about 15 seconds plus request time to observe rejection.
Offline presence may take 45 seconds to expire. Presence is not authorization.

## Overload and monitoring

Full queues or checkout deadlines return retryable 503 responses with Retry-After,
not an invalid-token response. No SQL runs for a request whose checkout already
timed out; late-arriving connections are released. Already-running SQL is not
automatically retried or cancelled (avoids duplicate writes/uncertain transactions).
Timed-out mysql2 queue entries remain bounded by queueLimit until serviced.

Once per minute, workers log `[mysql-pool]` when queue pressure occurs. Fields:
pending acquisitions, currently checked-out connections, and lifetime totals of
acquisitions, timeouts, failures and enqueue events. Logs contain no SQL, credentials
or customer identifiers. These are per-worker counters, not MySQL server totals.
Keep worker count in mind: N workers can open up to 10*N connections.

WHMCS retains its durable cross-worker due slot and a minimum five-minute lease.
Its connection/advisory lock is released before external HTTP. Batched writes
require the same unexpired lease; an expired worker cannot overwrite device status.
Only Active/Suspended are synchronized; unknown or failed responses do not suspend.
SIGTERM/SIGINT stop recurring timers, drain HTTP and close the pool, with a
15-second shutdown deadline for long-lived video proxy connections.

Verify production logs, queue waits and MySQL Threads_connected/Threads_running
after deployment. Local fixture tests do not prove production load capacity.
