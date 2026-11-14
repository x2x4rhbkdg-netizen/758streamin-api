# Safe playback diagnostics

These changes are local code only. They do not deploy, restart services or change
playback authorization, candidate ordering, timeouts, or response status codes.

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
the physical TV. This patch adds diagnostics only, not a verified provider fix.

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
