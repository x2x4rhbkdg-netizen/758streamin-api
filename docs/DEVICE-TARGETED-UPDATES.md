# Device-targeted updates

## Deployment

1. Back up the database and run `src/db/app-update-targeting.mysql.sql` in the selected StreamIN database (for example, in phpMyAdmin's SQL tab).
2. Deploy the API and dashboard changes together. The updated API requires the new column and recipient-aware unique index.

Existing update records remain available to all devices. The migration is safe to rerun. No new APK is required for clients already sending their device UUID when checking for updates.

## Dashboard

In App Updates, choose All devices or Specific device. For a specific recipient, enter its existing device activation code. Unknown device codes are rejected. Both create and edit support changing the recipient. Existing super-admin management permissions remain in place.

The API resolves the code to the device's database ID. A subsequent code edit follows that device record; deleting and recreating a device does not reuse its targeted release.

## API

Admin create/PATCH accepts `target_device_code`. Omitted on create or explicit null selects all devices; omitted on PATCH preserves the saved recipient. Admin listing includes `target_device_id` and `target_device_code`. Non-super-admin listing includes general releases only.

Update checks accept `device_uuid` and optional `device_code`. If both are supplied they must identify the same record. Missing or unknown identity receives general releases only. Selection filters by recipient, channel, platform and active release status before choosing the highest version. A device-specific release wins over a general release at the same version. Only versions newer than the installed version are offered.

The existing startup/Check Updates flow delivers the offer. This is not a push notification or silent APK installation. Android installation confirmation and existing compatibility/signing rules still apply.

## WHMCS status sync

Both WHMCS sync endpoints activate the device only when the fetched service billing status is Active (case-insensitive, ignoring surrounding whitespace). All other WHMCS statuses leave the current device status unchanged. This does not alter expiry/trial dates or bypass existing access checks. The Edit Device status selector refreshes after sync so Save does not restore its previous value.
