# 758streamin API Documentation

## Overview
- Base URL: `/`
- Version prefix: `/v1`
- Content type: `application/json` unless noted
- Auth:
  - Device JWT: `Authorization: Bearer <token>`
  - Admin key: `x-admin-key: <ADMIN_API_KEY>`

## Health and Root
### GET /
Returns basic service info.

Response 200:
```json
{
  "ok": true,
  "service": "758streamin API",
  "docs": "/health",
  "version": "v1"
}
```

Note: `/health` is referenced in the root response but is currently commented out in the app.

## Device
### POST /v1/device/register
Registers or updates a device and returns a device code.

Body:
```json
{
  "device_uuid": "string",
  "platform": "string",
  "model": "string",
  "app_version": "string"
}
```

Response 200:
```json
{
  "device_code": "string",
  "status": "pending"
}
```

Errors:
- 400: `device_uuid required`
- 400: `invalid device_uuid`
- 500: `device_code collision` or `internal error`

### POST /v1/device/auth
Authenticates a device and returns a JWT.

Body:
```json
{
  "device_uuid": "string",
  "device_code": "string"
}
```

Response 200:
```json
{
  "access_token": "jwt",
  "max_streams": 1,
  "expires_at": "2025-01-01 00:00:00"
}
```

Errors:
- 400: `device_uuid + device_code required`
- 401: `device not registered`
- 403: `device not active` or `device expired`
- 500: `internal error`

## Playlist
### GET /v1/playlist.m3u8
Proxies the upstream playlist for an authenticated device.

Headers:
- `Authorization: Bearer <token>`

Response 200:
- Content-Type: `application/vnd.apple.mpegurl; charset=utf-8`
- Body: M3U text

Errors:
- 401: `missing token` or `invalid token`
- 404: `no upstream configured for device`
- 502: `upstream failed`
- 500: `internal error`

## Admin (requires x-admin-key)
### GET /v1/admin/devices?search=
Lists up to 200 recent devices, with optional search.

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Response 200:
```json
{
  "devices": [
    {
      "device_code": "string",
      "status": "pending|active|suspended",
      "platform": "string",
      "model": "string",
      "app_version": "string",
      "last_seen_at": "2025-01-01 00:00:00",
      "created_at": "2025-01-01 00:00:00",
      "updated_at": "2025-01-01 00:00:00",
      "expires_at": "2025-01-01 00:00:00",
      "max_streams": 1
    }
  ]
}
```

Errors:
- 401: `admin unauthorized`
- 500: `internal error`

### PATCH /v1/admin/devices/:code
Updates device fields and optional access limits.

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Body:
```json
{
  "customer_name": "string",
  "status": "pending|active|suspended",
  "max_streams": 1,
  "expires_at": "2025-01-01T00:00:00Z"
}
```

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `device code required` or `invalid status` or `no fields to update`
- 404: `device not found`
- 500: `internal error`

### POST /v1/admin/devices/:code/activate
Sets a device to active and upserts access limits.

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Body:
```json
{
  "expires_at": "2025-01-01T00:00:00Z",
  "max_streams": 1
}
```

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `device code required`
- 404: `device not found`
- 500: `internal error`

### POST /v1/admin/devices/:code/suspend
Sets a device to suspended.

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `device code required`
- 404: `device not found`
- 500: `internal error`

### POST /v1/admin/devices/:code/upstream
Stores upstream credentials for a device.

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Body:
```json
{
  "upstream_base_url": "https://example.com",
  "username": "string",
  "password": "string"
}
```

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `device code required` or `upstream_base_url + username + password required` or `invalid upstream_base_url`
- 404: `device not found`
- 500: `internal error`

## Environment
Required:
- `JWT_SECRET`
- `ADMIN_API_KEY`
- `ENC_KEY_BASE64`
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

Optional:
- `ALLOWED_ORIGINS` (comma-separated)
- `PORT` (default 3000)
- `DB_PORT` (default 3306)

## Database Schema (MySQL)
Tables:
- `devices`
- `device_access`
- `device_upstream`

View:
- `v_admin_devices`
