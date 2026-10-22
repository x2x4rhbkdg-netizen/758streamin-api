# ThePornDB catalog integration reference

Reviewed 2026-10-22 against the public OpenAPI spec, version `v3.24.759`.

- Documentation: https://api.theporndb.net/docs#/
- Specification: https://api.theporndb.net/specs?openapi.json
- API origin: https://api.theporndb.net

The connector is implemented and disabled by default. Verification so far uses synthetic
responses; no real account token or authenticated live catalog/playback request was used.

## Enable the connector

1. Deploy the API and dashboard changes together. The current Adult-capable app already
   understands the catalog/item/source response shape; retain the app's age/PIN changes.
2. Sign in as a super admin and open **Media Settings**.
3. Enter a private token in **ThePornDB API Token** (token only, no `Bearer ` prefix).
4. Select **Test ThePornDB Connection**. This is read-only and does not save the token.
5. Check **Enable ThePornDB catalog**, then **Save Media Settings**.
6. Keep Adult Content enabled for the intended device. In the app, confirm 18+, enter
   its mandatory PIN and open the Scenes, Movies or JAV catalog.
7. To search the same WEYD-style scraper packs as Movies/Series, check **Use shared
   scrapers for Adult playback** and save. This is off by default: enabling it sends
   the selected Adult title and release year to the configured scraper services.

The token is saved in the existing encrypted global settings record. Responses expose
only `theporndb_token_configured`; unrelated saves and disabling preserve the token.
To remove it, disable the connector and select its **Remove credential** checkbox before saving.
No new database migration is required if existing global media settings are deployed.

The super-admin-only connection test is `POST /v1/admin/movie-settings/theporndb/test`.
Its body is `{}` for the stored credential or `{ "token": "<private token>" }` to test an
unsaved credential. Responses contain only a safe status/message, never title metadata
or credentials. The dashboard proxy also verifies its session role and request origin.

## Security controls to preserve

Keep the 18+ self-declaration before the mandatory PIN, persisted Hide Adult Content,
server-enforced age/PIN checks, protected playback links, and current-PIN authorization
for PIN reset or replacement. See `ADULT_SECURITY.md`.

## Authentication

The spec declares the `sanctum` API-key security scheme using the `Authorization`
header with the value `Bearer <token>`. This is not RapidAPI authentication.
The token belongs only on the StreamIN server. Never include it in the Android app,
client responses, image URLs, browser query strings or logs.

## Read endpoints

| Purpose | Method and path |
| --- | --- |
| List/search scenes | `GET /scenes` |
| List/search movies | `GET /movies` |
| List/search JAV | `GET /jav` |
| Details | `GET /scenes/{identifier}`, `/movies/{identifier}`, `/jav/{identifier}` |
| Similar titles | `GET /scenes/{identifier}/similar` and corresponding movie/JAV paths |
| List/search sites | `GET /sites` |
| Site details | `GET /sites/{identifier}` |
| Site titles | `GET /sites/{identifier}/scenes`, `/movies`, `/jav` |
| List/search performers | `GET /performers` |
| Performer details | `GET /performers/{identifier}` |
| Performer titles | `GET /performers/{identifier}/scenes`, `/movies`, `/jav` |
| List/search tags | `GET /tags` |

Identifiers may be a slug, ID or UUID. Encode them as individual URL path segments.
Use read-only requests for the catalog. Do not call upstream favorites, collection,
ratings or creation/deletion endpoints: saved titles and history belong to StreamIN.
Do not set `add_to_collection` on detail requests.

## Search and paging

The scene/movie/JAV list endpoints document `q`, `page`, `per_page`, `orderBy`,
`title`, `year`, `date`, site, performer, director, tag and other filters.
`per_page` is bounded from 1 to 100. Preserve query/filter values between pages.

Documented sorting values are `duration_asc`, `duration_desc`, `former_created`,
`former_released`, `former_updated`, `most_relevant`, `recently_created`,
`recently_released`, `recently_updated`.

List responses contain `data: []` and `meta` with `total`, `per_page`,
`current_page`, `last`. Detail responses contain `data: { ... }`.
Do not assume a `last_page` field; the current spec names it `last`.

## Metadata mapping

Use a namespaced identity including resource kind and `id`, not an unqualified
numeric ID. Keep the current capability envelope around every returned item.

| ThePornDB field | StreamIN use |
| --- | --- |
| `id`, `type` | Stable namespaced catalog identity |
| `title` | Display title |
| `description` | Overview |
| `date` | Release date |
| `duration` | Duration; verify units against authenticated data before conversion |
| `poster`, `poster_image`, `posters` | Artwork candidates; retain protected image handling |
| `background`, `back_image`, `image` | Additional artwork |
| `site`, `performers`, `tags`, `directors` | Metadata/filter associations |
| `scenes`, `movies` | Related scene/movie associations |

Nullable artwork and optional/missing fields must not prevent browsing. Validate
all remote image URLs through existing network protection, and never forward the
API bearer token to image CDN hosts.

## Playback boundary

No full-video playback-source endpoint is documented in this specification.
`SceneResource.url` is a source webpage, not a guaranteed playable file.
`trailer` is not a full-length playback substitute. `MediaResource` describes an
image, not a stream. `hashes` use `OSHASH` or `PHASH`, not BitTorrent info hashes.
Never send those hashes to debrid providers as torrent hashes.

The ID-based bridge requests sources from enabled Adult Stremio add-ons
explicitly declaring `tpdb:` or a resource-specific prefix such as `tpdb:scenes:`.
It sends `stream/movie/tpdb%3Ascenes%3A<id>.json`, using the exact kind and returned
ThePornDB `id`. These namespaced IDs are a StreamIN adapter contract, not a claim
that arbitrary existing add-ons support them. Manifest-level or stream-resource-level
prefixes are accepted; an unrestricted manifest or generic `t` prefix is not sufficient.

The separate shared-scraper path is opt-in via `adult_use_shared_scrapers`. It uses
the existing scraper discovery engine and its title/year and content-filter checks,
with server-issued metadata from the encrypted Adult item, not arbitrary client search
input. Mainstream Stremio add-ons are excluded from this path. Stremio `manifest.json`
URLs in the scraper fields are ignored by this path: register those under Stremio
Add-ons with Adult-only scope instead. Title searches that cannot be safely handled
by the current matcher are skipped rather than returning unrelated results.

Matched torrent hashes proceed through the existing enabled-provider availability
checks and provider resolver. Only a user-selected, signed source can be resolved.
Title-search torrents must contain one unambiguous video; they cannot automatically
select the largest file from a multi-video pack. Source capabilities are invalidated
when shared scrapers are disabled or their configured URLs change. Up to two shared
Adult scraper searches run at once; the existing per-search timeout/work limits apply.

ThePornDB itself still supplies no full-video links. Without matching scraper results
or a compatible add-on, browsing can work while a title has no playable sources.
Existing Adult add-on catalogs continue working independently. Do not remove them
expecting ThePornDB to supply streams. Source selections are invalidated when
their owning add-on is disabled/reconfigured; catalog capabilities are invalidated
when ThePornDB is disabled or its token changes. History remains owned by StreamIN.

## Implementation notes

A dedicated metadata adapter supplies search, 25-item paging and details. It uses
an eight-second timeout, a two-MiB response cap, four active requests, single-flight
deduplication, a bounded five-minute cache keyed by hashed credential, and 429
cooldowns. There are no automatic retry bursts or credential-bearing redirects.
Connection tests bypass cached responses. Source discovery uses at most three
concurrent add-on requests with an eight-second overall abort deadline.
The specification does not state a numeric rate limit, so no quota is invented.

Before enabling: configure a private server token, validate authenticated sample
responses, confirm applicable usage permissions, and test paging, unavailable
sources, token revocation, hidden-section guards and TV remote focus. This review
does not establish content licensing or playback rights.

## Verification and release status

- 259 API tests pass, including shared scraper matching, provider resolution, source
  identity, PIN/age and history checks.
- 40 focused Adult/security app tests pass, including persistent horizontal category
  tabs, poster traversal, append focus and Back restoration.
- Dashboard desktop/mobile fixture tests pass for enable/test/save/reload/removal,
  keyboard traversal, credential masking and preserving playback-provider settings.
- Existing anime-primary dashboard regression checks pass on desktop/mobile.
- Dashboard page and new proxy route compile on an isolated development server.
  Normal local login is blocked until `ADMIN_COOKIE_SECRET` and the other dashboard
  environment settings are supplied; fixture tests do not establish live authentication.
- No production deployment, authenticated ThePornDB request, compatible live source
  add-on validation, or physical-TV playback/remote test has been performed.
