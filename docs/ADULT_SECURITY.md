# Adult access controls

## App behavior

- Require an explicit 18+ confirmation before entering the mandatory PIN.
- Confirmation is self-declaration, not identity or third-party age verification.
- Reset confirmation and unlocked state on backgrounding, section exit or explicit lock.
- Persist Hide Adult Content per installation under `streamin.adult.hidden.v1`.
- Hide removes Adult navigation and blocks guarded Adult routes. Revealing the section requires PIN verification.
- Hiding is a local presentation preference, not a replacement for server entitlement or access checks.

## API contract

All Adult JSON routes require the authenticated device and its current Adult entitlement.

`POST /v1/adult/unlock` requires `{ "pin": "<four digits>", "age_confirmed": true }`.
Only boolean `true` is accepted. PIN verification remains mandatory. Scoped capabilities
include the age-confirmation marker and current PIN fingerprint; older capabilities are rejected.

Protected Adult playback tickets also include the confirmation marker. The stream proxy
rechecks current entitlement and PIN fingerprint and rejects older tickets. Public API
playback links remain HTTPS; private-address rejection, redirect validation and opaque
proxy URLs remain in place.
Do not log PINs, unlock tokens, playback tickets or provider credentials.

## Stremio direct media

Adult direct media supports HTTP on port 80 and HTTPS on port 443 through the
protected API proxy. This does not enable HTTP for general movie/anime playback
or change the HTTPS manifest configuration requirement. HTTP provider traffic is
not encrypted between the API and provider; use HTTPS sources when available.

Stremio `behaviorHints.proxyHeaders.request` can contain User-Agent, Referer,
Origin, Accept, Authorization and Cookie. Header names are normalized, values are
printable ASCII with strict size limits, and request framing/routing headers such
as Host, Range, Content-Length and Connection cannot be supplied by an add-on.
Add-on response-header overrides, DASH/DRM and external webpage URLs remain
unsupported. Empty proxy-header objects are accepted.

URLs and approved headers remain inside encrypted, device/PIN-scoped capabilities
and playback tickets. Headers apply only to the original media origin (scheme,
host and port), never a different redirect/CDN origin or an HTTPS-to-HTTP
downgrade. Cross-origin media that requires those credentials may still fail;
do not relax this policy by forwarding credentials to arbitrary destinations.

Each redirect, playlist, key, segment and subtitle/audio playlist still passes
destination validation and public DNS pinning. HLS child tickets retain the
original header origin and the existing device/PIN/age marker. The server forwards
Range itself, preserves existing playback limits, and strips upstream redirect
and cookie headers from the public response. No raw media URL, header or token
is added to logs.

### Protected HLS format handoff

Confirmed HLS resolve results return `/v1/movies/stream/<encrypted-ticket>.m3u8`
with additive `format: "hls"` and `mimeType: "application/vnd.apple.mpegurl"`
metadata. The suffix lets URI-based players select HLS instead of attempting a
progressive-file extractor. It is not an authorization capability: the original
encrypted ticket, age marker, current device permission and PIN checks are still
required on every request. Legacy extensionless tickets remain valid.

For sources without a recognizable playlist path, resolve performs a best-effort
HEAD probe, followed by a GET-headers-only probe if HEAD is unsupported or
inconclusive. Both share a four-second deadline; no movie body is buffered. The
probe uses validated public DNS pinning, standard Adult HTTP/HTTPS port rules,
at most three redirects, and origin-scoped headers. It runs only after all
resolve authentication, device, unlock/PIN, source and selection checks succeed.
It may add latency and provider requests; failures retain the existing untyped
URL rather than guessing that an MP4 is HLS. No probe cache or new secret is used.

Nested variant/audio/subtitle playlists also retain `.m3u8` on their encrypted
proxy links, including extensionless URIs identified by playlist tags. Keys,
maps and media segments are not mislabeled as playlists. The actual upstream
response, not a caller-supplied suffix, determines whether the proxy rewrites HLS.
Opaque headers and credentials are never included in the player URL or logs.
Android's HLS selection requirements are documented in the
[Media3 source factory reference](https://developer.android.com/reference/androidx/media3/exoplayer/source/DefaultMediaSourceFactory).

After deploying this change, reopen the source selection to obtain a new typed
playback link; an already issued extensionless link does not change retroactively.
Provider/physical-TV playback must still be verified after deployment.

PIN management requires device authentication:

- `POST /v1/device/adult/set`: `{ "pin": "<new PIN>" }` for initial setup.
- Replacing an existing PIN additionally requires `current_pin`.
- `DELETE /v1/device/adult/reset`: `{ "current_pin": "<existing PIN>" }`.
- Verify, set and reset share a five-attempt/five-minute per-device limit per API worker.
- Conditional writes prevent concurrent changes from overwriting a newer PIN.

The limiter is process-local. Multiple API workers do not share counters; a shared
rate-limit store is needed for an installation-wide attempt budget.

## Deployment

Coordinate API deployment with an updated Android app build. Existing Adult unlock
capabilities and playback tickets are deliberately invalidated; users must confirm age
and enter their PIN again. Older apps cannot supply the age marker or reset-PIN payload.
No database migration or new secret is introduced by these changes.

Automated tests cover age/PIN gates, visibility, token rejection, PIN-reset authorization,
concurrent PIN changes and remote-focus mappings. Physical-device verification is still required.

## JSON Porn connector: pending

No JSON Porn connector has been enabled. The linked RapidAPI playground does not expose
sufficient unauthenticated endpoint documentation to implement a verified connector.
Obtain redacted cURL examples and response JSON for producers, catalog/search, details,
images and playback/download sources, including the exact RapidAPI host and pagination.
Do not paste the API key into chat or include it in the APK. Keep it in server-side configuration.
Preserve the existing authenticated, PIN-scoped catalog and protected playback flow when
adding the adapter; do not expose provider URLs or keys directly to the app.

The user subsequently selected ThePornDB instead. Its implemented catalog connector,
activation steps and explicit playback limitations are in `THEPORNDB_INTEGRATION.md`.
The security controls in this document remain required for that connector too.
