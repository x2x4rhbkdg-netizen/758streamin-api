# Advanced Anime Search

Deploy the API changes before distributing the matching StreamIN app build. No SQL migration or new credentials are required.

- `GET /v1/movies/anime-filters?section=anime&q=<studio search>&page=1` returns safe genre/tag choices and paginated animation studios.
- `GET /v1/movies/catalog?section=anime&type=series&q=<title>&page=1&anime_filters=<URL-encoded JSON>` applies advanced filters. Movie scope uses `type=movie`.
- Both routes retain device JWT authentication and the existing Anime access check.
- JSON fields: `genres` and `tags` (up to 10 names each), `format`, `availability`, `year`, `season`, `status`, `studio` (AniList ID), `minDuration`, `maxDuration` (minutes per episode), `minEpisodes`, `maxEpisodes`, `sort`.
- Cleared UI defaults: empty title, Any optional fields, All titles, minimums zero, Popularity sorting. Zero minimums are unbounded; maximums and years must be omitted when unset.
- The app currently enables only `availability=all`. Dub (English audio) and Sub (Japanese audio with English subtitles) are displayed as disabled, not-indexed choices. They require verified playback data and are not inferred from metadata or filenames. Building that index remains follow-up work; these choices must not be enabled until a verified data source is connected.
- Advanced queries use AniList's full filter vocabulary regardless of the normal primary catalog. Ordinary browsing/title-only search still follows the dashboard primary and failover order. On advanced-query outage return an error, never silently remove filters or return unfiltered fallback titles.
- Advanced responses include `anime_filters_applied: true`; the app rejects old-server responses lacking this marker rather than displaying misleading results.
- Studio queries paginate the studio's sorted media IDs, then intersect those IDs with all remaining filters. Sparse/empty pages can occur; `total_pages` exposes the next page while the studio has more media. Load More must retain the complete filter object.
- All results retain canonical AniList identities and existing verified Kitsu playback mapping. Filtering never fabricates a playback or sub/dub identity.
- Reuses the bounded AniList metadata cache, request coalescing, timeout, and outage backoff. No catalog mirror, background library scan, or per-title playback-source probing is added.

Reference: https://docs.anilist.co/reference/object/page and https://docs.anilist.co/reference/object/studio
