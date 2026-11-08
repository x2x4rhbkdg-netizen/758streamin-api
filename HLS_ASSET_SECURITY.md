# HLS asset destination hardening

## Scope

This is the security-only stage. No additional video traffic is routed through
the API. Embedded manifests still return absolute upstream segment URLs as
before. This change does not conceal those URLs or add DRM. Full streaming,
CDN delivery and changing embedded manifest routing remain separate work.

JWT signature/audience/issuer/expiry checks, the fresh joined device lookup,
device deletion/status/subscription checks and playback limits are unchanged.
No database queries, per-device session limits or background polling were added.

## Asset routes

- `/v1/playback/hls-asset` still requires a server-issued asset identifier bound
  to the exact playback token. A user-supplied `url` cannot select its target.
  Server-issued targets and public CDN redirects remain supported. Every target
  is independently checked for a public address, including redirects.
- `/v1/playback/embedded-hls-asset` retains its legacy URL parameter, but now
  allows only the device's configured upstream origin and explicitly approved
  origins. Scheme, hostname and port must match exactly, on every redirect.
  No current Android/Samsung client call sites were found for this legacy route.
- Neither path can connect to private, loopback, link-local, multicast,
  IPv4-mapped/private IPv6 or blocked special-purpose addresses, even when the
  origin is explicitly approved. Mixed public/private DNS answers fail closed.
- DNS results are checked and pinned to the actual socket lookup. Isolated
  keep-alive pools reuse only sockets established through this checked lookup;
  they do not share unchecked global-agent sockets.
- HTTP/HTTPS and custom provider ports are preserved for authorized targets.
  URL userinfo credentials and non-HTTP schemes are rejected. Credentials in
  existing provider URL paths/query strings remain compatible.
- Redirects are limited to five. The configured XUI request timeout covers
  DNS, redirects and the response body as one deadline.
- Existing buffering is retained, but capped at 64 MiB per response, both wire
  bytes and decompressed bytes. Gzip, deflate and Brotli are supported. Oversized
  responses fail with 502; destination denials return 403. These limits do not
  increase the amount of video proxied or change concurrent playback limits.

## Deployment

Deploy these files together, then restart the Node/Passenger API application:

- `src/routes/playback.routes.cjs`
- `src/utils/playbackAssetHttp.cjs`
- `src/utils/scraperHttp.cjs` (existing shared public-address utility)
- `src/utils/hlsUpstreamDiagnostics.cjs` (required by the earlier diagnostics change)

No database migration, dependency installation or mobile rebuild is required.

If a legacy asset caller redirects to an additional CDN origin, explicitly set
the API process environment variable, for example:

```text
PLAYBACK_ASSET_ALLOWED_ORIGINS=https://cdn.example.com,http://cdn.example.com:8080
```

Use actual approved origins; no wildcards. Leave unset when not needed. This
setting applies only to the legacy arbitrary-URL route. Opaque server-issued
assets already have server-side provenance and can follow public CDN redirects.
Private upstreams and responses exceeding 64 MiB are deliberately blocked by
this security policy; do not use an allowlist entry to bypass address checks.

## Validation

```sh
node --test --test-reporter=dot src/db/*.test.cjs src/utils/*.test.cjs src/routes/*.test.cjs src/middleware/*.test.cjs
```

Focused tests cover address/redirect restrictions, DNS pinning and rebinding,
range metadata, custom ports, compression limits, deadlines, token binding and
device deletion/suspension/expiry denial before any asset request. Local tests
do not establish live provider or physical-TV compatibility. Before broad
deployment, smoke-test an authorized HLS channel, a CDN redirect and channel
switching, and verify that deleting/suspending a device denies new API requests.
Existing direct upstream connections are not newly revoked by this stage.
