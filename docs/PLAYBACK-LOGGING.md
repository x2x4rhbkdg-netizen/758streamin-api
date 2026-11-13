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
