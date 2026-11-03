# Architecture-specific Direct APK Updates

Run `src/db/app-update-variants.mysql.sql` before deploying this API. It adds
nullable `apk_variants` storage; existing universal releases are unchanged.

Admin `POST /v1/admin/app-updates` and `PATCH /v1/admin/app-updates/:id` accept:

```json
{
  "apk_variants": {
    "arm64-v8a": { "apk_url": "https://cdn.example.com/v96/tv-arm64.apk", "sha256": null },
    "armeabi-v7a": { "apk_url": "https://cdn.example.com/v96/tv-arm32.apk", "sha256": null }
  }
}
```

Supported keys: `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`. Variant URLs must be
HTTPS, without embedded credentials, and at most 2000 characters. Optional SHA256
hashes must be 64 hex characters. Each hash belongs to that APK, not the universal
file. The existing required `apk_url` and optional `sha256` remain the universal
fallback. Keep every APK in a release on the same version code and signing key.

Omit `apk_variants` on PATCH to preserve existing entries. Send `{}` or null to
clear them. Supplying a map replaces the full map. Admin listing returns parsed
objects. Only super admins can create/edit releases, as before.

Direct update checks accept optional `supported_abis` in Android OS preference
order, e.g. `["arm64-v8a", "armeabi-v7a"]`. Recipient, channel, platform, active
status and version selection happen first. Then the first configured compatible
variant is selected. Response fields `apk_url` and `sha256` refer to that variant;
`architecture` identifies its ABI or `universal`. Full variant maps and targeted
device identity are not included in the public update response.

Old clients, unrecognized or missing ABI lists and missing/invalid stored maps
receive the universal fallback. Store channels ignore variant maps. Do not deploy
ABI-only releases without the universal fallback: older clients still need it for
their first architecture-aware update. There is no delta patching or automatic
variant-download failure fallback in this implementation.
