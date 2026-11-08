# HLS upstream failure diagnostics

Deploy both source files and restart the API worker:

- `src/routes/playback.routes.cjs`
- `src/utils/hlsUpstreamDiagnostics.cjs`

`fetchTextWithResolvedUrl` emits `[hls-upstream-failure]` on failed upstream
manifest/text candidate attempts. Successful attempts and binary/segment fetches
do not emit these messages. It records failures before moving to the next candidate,
including intermediate HTTP 5xx responses that previously bypassed the catch block.

Fields: failure_type (http, timeout, aborted, dns, tls, connection, network), HTTP
status or network-error, allowlisted error name/cause code, sanitized message,
elapsed_ms (monotonic per-candidate time including response-body read), timeout_ms,
candidate (one-based), totalCandidates, and suppressed_since_last_log.

No raw exception messages, URLs, paths, response bodies, tokens or credentials
are logged by this diagnostic. Unknown error names/codes are normalized. Examples
of recognized cause codes include ENOTFOUND, EAI_AGAIN, ECONNRESET,
UND_ERR_CONNECT_TIMEOUT and CERT_HAS_EXPIRED.

Logs are capped at 20 entries per minute per worker. The next emitted record
reports how many diagnostic entries were suppressed. These are sampled diagnostics,
not an exact count of failures or unique sessions; multiple workers have separate
limits. Suppression reporting occurs on the next eligible failure, not via a timer.

Timeout values, candidate order, fallback rules and client responses are unchanged.
Network failures and HTTP 5xx still fall back; HTTP 4xx still stop. Logging failures
cannot replace the original fetch result/error. No MySQL queries are added.

Use the observed failure types and elapsed times before deciding whether the
upstream timeout should change. No timeout increase is made by this change.
