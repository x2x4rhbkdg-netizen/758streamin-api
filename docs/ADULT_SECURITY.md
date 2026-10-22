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
rechecks current entitlement and PIN fingerprint and rejects older tickets. Existing HTTPS,
private-address rejection, redirect validation and opaque proxy URLs remain in place.
Do not log PINs, unlock tokens, playback tickets or provider credentials.

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
