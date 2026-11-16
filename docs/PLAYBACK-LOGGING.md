# Safe playback diagnostics

These changes are local code only. They do not deploy or restart services.
Playback authorization and candidate ordering are unchanged. The protected
movie proxy's backpressure-aware timeout policy is documented below; Live TV
timeouts are unchanged.

## Real-Debrid Account Checks

Both source availability checks and RD playback resolution read the account
torrent list using `limit=250&page=N`, as supported by the
[RD API](https://api.real-debrid.com/#torrents). The existing logical list request
is retained for injected test adapters, but the production adapter sends only
paginated requests. Concurrent source batches share one walk per search.

Each response retains the 2 MiB cap. Pages run sequentially under the existing
caller deadline (8 seconds for availability; playback has its existing overall
and provider deadlines). The walk stops on a short/empty page, retains only
id/hash/status, deduplicates IDs, and allows at most 40 page requests. A full
40th page, repeated full page, malformed response, or failed page fails the check
explicitly; partial results are not cached as ready or uncached. There are no
automatic HTTP retries or torrent additions during discovery. Large accounts
can still hit the deadline or page cap; pagination is not an unlimited scan or
an atomic snapshot of an account that changes during the check.

`[rd-account-check-failure]` emits one safe record per failed walk, subject to a
20-record/minute worker-wide limit. The next emitted record reports suppression.
Fields are fixed provider/operation, allowlisted category, page/page size,
completed-page count, elapsed milliseconds, optional HTTP status, optional
numeric RD error code, and an allowlisted network code. Categories distinguish
HTTP, network, timeout, size limit, invalid JSON/response, repeated pages and the
pagination cap. Raw messages, bodies, URLs, tokens, filenames, hashes, torrent
IDs, account/device identifiers and authorization headers are never logged.
Logger failures do not change provider results. Existing public provider-status
values and credential/rate-limit handling are preserved; other providers and
device/PIN checks are unchanged.

After an approved deployment, inspect recent RD check failures without dumping
HTTP payloads or credentials:

```bash
journalctl -u 758streamin-api.service --since "15 minutes ago" --no-pager -o cat |
  grep -F '[rd-account-check-failure]'
```

## Correlating a failure

`[hls-upstream-failure]` and `[playback]` records contain single-line JSON. Start
with `stream_id` (the provider's numeric channel/episode identifier, not a display
name) and `request_id`. The latter is server-generated for each incoming request;
it is not a customer-supplied header. Stream IDs are provider-scoped, so pair them
with `source_ref` when comparing providers.

- `stage`: source_lookup, manifest, nested_manifest, or an asset kind such as key,
  segment_ts, segment_m4s, audio, asset, unknown. Authorization failures may have
  no stream/source identity because authorization has not completed.
- `source_ref`: keyed HMAC of the credential-free destination origin, including
  scheme and port. Paths, query strings and URL userinfo never enter this value.
  Redirected manifest HTTP responses and asset destinations use the observed
  destination; network failures during automatic manifest redirects may only
  identify the initial destination.
- `session_ref`: keyed, non-reversible correlation reference derived from the
  playback-token fingerprint. Neither the JWT nor its existing fingerprint is
  printed. This is still pseudonymous viewing data: restrict access and retention.
- `candidate`, `totalCandidates`: attempt position within a single manifest fetch,
  not independent providers. HTTPS/HTTP variants can share the same provider.
- `request_complete`: terminal HTTP outcome, `ok`, `recovered`, `failed`, or
  `aborted`. `recovered` means a request succeeded after a recorded failure; it
  does not prove video rendered on the TV. `last_failed_source_ref` can differ
  from the final `source_ref`. Child playlist requests have independent request
  IDs but the same session reference.

Source-lookup diagnostics record the final lookup failure after the existing XUI
fallback finishes; their elapsed time covers that lookup. They do not assign a
candidate number. Manifest diagnostics record each failed candidate. Asset
diagnostics cover segments, keys and nested playlists on both asset routes.
Successful asset requests are quiet.

## Private source mapping

For stable references across workers and restarts, provision an independent,
random `PLAYBACK_LOG_SECRET` (at least 32 random bytes) through the service's
protected environment in a later approved deployment. Do not reuse JWT secrets
or playlist passwords, and do not paste the logging secret into chats or shell
arguments. Without it, a process-random key is used: playback still works, but
references cannot be compared across processes or restarts.

An authorized operator can compute the source mapping locally using
`playbackLogging.source('https://provider.example:8443').source_ref` from
`src/utils/playbackLogging.cjs` with the same protected environment. Use only a
credential-free origin, never a full playlist URL. Keep the mapping private.

## Limits and safety

Attempt logs retain the 20-per-minute, per-worker cap. Routine playback records
and terminal failure/recovery records have separate 60-per-minute budgets, so
routine traffic cannot consume the failure-outcome allowance. Each budget reports
its suppressed count on its next emitted record; this is not an exact per-source
failure count. Terminal outcomes are also bounded and can be suppressed.

Playback debug logging allowlists fields and omits raw URLs, device identifiers,
headers, messages, bodies and tokens. The playback internal-error logger receives
a sanitized record while retaining the original error for existing response/DB
handling. This does not audit Apache access logs, other routers, or explicit API
debug-error response settings. Do not enable verbose credential-bearing logging
to diagnose failures.

## Protected direct streams

The `/movies/stream/:ticket` route uses the same safe request context. Its route
label is fixed: the actual encrypted ticket, Adult title/ID, PIN fingerprint,
device ID and URL path are never printed. `media_type` identifies Adult, anime
or regular video; `source_ref` identifies only the opaque provider origin.

`[movie-upstream-failure]` is rate-limited separately from HLS attempts and records
sanitized status/error-code categories. Stages distinguish ticket_validation,
authorization, destination_validation, dns, request_headers, connect, redirect,
upstream_headers, manifest_rewrite and body_transfer. A failed native HTTP request
can contain a TLS error even at the connect stage; consult its safe error code.

`stream_response` records upstream status, a MIME category (`hls`, `video`,
`audio`, `html`, `json`, `binary`, `other`), redirect count, whether add-on headers
were applied and whether a range was requested. It never prints raw header names
or values, MIME parameters, Location, cookies or response bodies. For example,
upstream 403 followed by terminal 502 shows a provider rejection, while upstream
200 with `html` shows that a webpage was returned instead of video. Neither proves
why the provider behaved that way. An origin change with
`addon_headers_applied:false` confirms header isolation, not that credentials
should be forwarded to the new destination.

Authorization and ticket denials appear as terminal 403 before an upstream call;
valid media responses and transfer completion do not prove playback decoded on
the physical TV. Diagnostics alone are not a verified provider fix.

## Stream Lifecycle

Protected movie/anime/adult byte transfers forward `If-Range` only alongside a
valid single `Range` request. Unmodified upstream media responses preserve `ETag`
and `Last-Modified` for GET/HEAD as well as existing range headers. The origin
decides whether a validator matches: a full `200` response is never relabeled or
sliced into `206`, and upstream `416` responses retain their `Content-Range`.
Rewritten adult HLS manifests do not inherit upstream validators because their
bytes have changed. Cache policy remains private/no-store; access is checked on
every request. No validators, range offsets or header values are logged.

Protected movie/anime/adult transfers also emit one bounded `stream_lifecycle`
record at route cleanup, subject to the existing per-worker logging budgets.
Its `events` array records observation order and elapsed milliseconds for final
upstream headers, upstream abort/error/end/close, request errors, downstream
finish/error/disconnect, and proxy cleanup. `socket_timeout` means the actual
upstream socket timeout callback fired; `headers_deadline` means the initial
30-second authorization/connect/headers deadline fired. `timeout_ms` in older
failure records alone does not establish a timeout. For protected media bodies,
`upstream_idle_timeout` and `downstream_stall_timeout` distinguish the new policy.

`upstream_bytes_consumed` counts body bytes consumed by the proxy, not bytes
delivered to or decoded by the player. `upstream_complete` is Node's HTTP message
completeness flag. `downstream_finished` means the response was handed to the
local transport, not acknowledged by the TV. `upstream_paused_at_snapshot` is
only a cleanup-time snapshot, not proof of sustained backpressure.
Only final-response lifecycle events are observed, not redirect response bodies.
Events following route cleanup are not captured. Event order identifies what
Node observed first, not the physical cause: pipeline destruction can cascade
across both streams. A downstream disconnect may be the player or Apache.
No payloads, URLs, range offsets, headers, device IDs, PINs or tickets are added.

## Protected Movie Body Timeouts

Before this fix, local Node 20 tests reproduced the native 30-second socket
timeout firing while pipeline backpressure intentionally suspended upstream
reads. Those old `socket_timeout` records did not distinguish source inactivity
from intentional read suspension. Cleanup-time pause flags alone cannot do so.

The protected movie/anime/adult proxy now uses:

- The existing 30-second overall authorization/connect/final-headers deadline.
  Per-hop socket timeout remains enabled until headers, then is disabled.
  Redirect response bodies are destroyed, not drained indefinitely.
- A 30-second body-idle window measured from consumed body data, not total
  transfer duration. Body progress refreshes this window.
- A separate 120-second continuous downstream-drain limit while response writes
  are backpressured. Source-idle accounting is suspended during this wait.
  A drain grants a fresh 30-second source-idle window. This is not a total
  playback/pause limit and cannot observe a TV hidden behind Apache buffering.
- Protection for final buffered response writes even after the source ends.
  Disconnection, completion, errors and route cleanup remove watchdog resources.

`upstream_idle_timeout` and `downstream_stall_timeout` lifecycle events are emitted
before timeout-triggered cancellation. Their failure records have the matching
`timeout_ms` (30000 or 120000) and `failure_type:"timeout"`, even if pipeline
reports a consequential reset. No header values, payloads or credentials are
logged. Authorization, PIN checks, ranges and Live TV routes are unchanged.
Bounded manifest reads also retain source-idle protection; an async iterator's
readable pause alone never suspends that protection.

Fast native HTTP tests and deterministic timer tests run with `npm test`.
The opt-in actual-duration case holds one downstream write for 31 seconds,
releases the drain, and checks that all 32 MiB arrive intact. It uses a controlled
write hold with native HTTP on both sides, not a long zero-window TCP pause:

```bash
MOVIE_PROXY_LONG_IDLE_TEST=1 node --test src/routes/movieStreamBackpressure.test.cjs
```

The 120-second drain limit is covered with deterministic timing and accelerated
native HTTP tests. The raw long TCP-pause fixture did not reliably recover even
with the new watchdog bypassed in the test process, so it is not claimed as a
passing recovery test. These are local transport tests, not production Apache,
MariaDB, provider-network or physical-TV playback proof.

## Adult Resolve Handoff


`POST /v1/adult/resolve` emits `adult_resolve_started` before device authentication,
`adult_resolve_result` after a protected playback URL is built, and one
`request_complete` record on completion/abort. Multiple mounted routers retain one
request ID rather than duplicating outcomes. Raw request bodies, PINs, device
identifiers, content titles/IDs, provider names, cookies, source/unlock/progress
tokens, and returned URLs/tickets are not logged.

Failure stages distinguish authorization (device JWT middleware), entitlement,
request_limits, pin_configuration, unlock_validation, source_validation,
selection_validation, provider_resolution, format_probe, history_lookup and protected_link.
Successful completion has stage `resolved`. HTTP status is the status actually
sent by the route; no arbitrary exception message is copied into the record.
`source_kind` distinguishes direct links from provider resolution after the signed
source has been validated. History failures retain their existing non-fatal
behavior and may still yield a successful resolve.

`protected_link_issued:true` with the fixed
`playback_route:"/v1/movies/stream/:ticket"` confirms a protected link was created,
not that the TV fetched or decoded it. Its opaque `session_ref` matches the
subsequent protected stream's reference in the same worker (or across workers
with the same `PLAYBACK_LOG_SECRET`). Pre-link denials have no ticket reference.
Adult resolve has separate routine/failure budgets of 60 records per minute each
per worker, so unrelated Live TV logging cannot consume its allowance. Suppressed
counts appear on the next emitted record; records can still be suppressed under
load, so absence alone is not proof that no request was made.

Resolve results also include the allowlisted `playback_format` diagnostic value
`hls`, `file` or `unknown`. `hls` results issue a `.m3u8` protected URL; the suffix
is excluded from the session fingerprint so resolve and media requests still
correlate. The diagnostic never includes the typed URL or ticket itself.

After an approved deployment, capture without exposing bodies or tickets:

```bash
journalctl -u 758streamin-api.service --since "now" -f -o cat |
  grep --line-buffered -E '"route":"/adult/resolve"|"route":"/movies/stream/:ticket"'
```
