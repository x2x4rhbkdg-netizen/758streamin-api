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
  "device_id": "string",
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
- 400: `device_uuid or device_id required`
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

## Catalog
### GET /v1/catalog/home
Returns home rails (Trending, New, Live Now, Categories).

Headers:
- `Authorization: Bearer <token>`

Query:
- `limit` (optional, default 20)

Response 200:
```json
{
  "rails": [
    { "key": "trending", "title": "Trending", "type": "vod", "items": [] },
    { "key": "new", "title": "New", "type": "vod", "items": [] },
    { "key": "live_now", "title": "Live Now", "type": "live", "items": [] },
    { "key": "categories", "title": "Categories", "type": "category", "items": [] }
  ]
}
```

### GET /v1/catalog/category/:id
Returns items within a category.

Headers:
- `Authorization: Bearer <token>`

Query:
- `type` (optional: `live|vod|series`)
- `limit` (optional, default 100)

Response 200:
```json
{
  "category_id": "123",
  "type": "vod",
  "items": []
}
```

## Content
### GET /v1/content/:id
Returns content metadata (vod/series/live), plus related items.

Headers:
- `Authorization: Bearer <token>`

Query:
- `type` (optional: `vod|series|live`)
- `related_limit` (optional, default 20)

Response 200 (vod example):
```json
{
  "id": "55",
  "type": "vod",
  "info": {},
  "movie_data": {},
  "related": []
}
```

## Live
### GET /v1/live
Returns live channels/events.

Headers:
- `Authorization: Bearer <token>`

Query:
- `limit` (optional, default 200)

Response 200:
```json
{
  "live": []
}
```

## Playback
### POST /v1/playback/token
Returns signed playback URLs and expiry.

Headers:
- `Authorization: Bearer <token>`

Body:
```json
{
  "type": "live|vod|series",
  "stream_id": "string",
  "episode_id": "string",
  "ttl_sec": 3600
}
```

Response 200:
```json
{
  "token": "jwt",
  "expires_at": "2025-01-01T00:00:00.000Z",
  "urls": {
    "hls": "/v1/playback/stream?token=...&format=hls",
    "dash": "/v1/playback/stream?token=...&format=dash"
  }
}
```

### GET /v1/playback/stream
Redirects to upstream stream URL after validating token.

Query:
- `token` (required)
- `format` (optional: `hls|dash`)

## Analytics
### POST /v1/analytics/event
Stores playback analytics events.

Headers:
- `Authorization: Bearer <token>`

Body:
```json
{
  "event_type": "play|pause|error|time_watched",
  "content_id": "string",
  "content_type": "live|vod|series",
  "position_seconds": 120,
  "duration_seconds": 240,
  "error_code": "string",
  "meta": { "any": "json" }
}
```

Response 200:
```json
{ "ok": true, "id": 123 }
```

## Admin (requires x-admin-key unless noted)
### POST /v1/admin/auth/login
Authenticates an admin (email or username + password).

Body:
```json
{
  "identifier": "email_or_username",
  "password": "string"
}
```

Response 200:
```json
{
  "admin": {
    "id": 1,
    "name": "string",
    "username": "string",
    "email": "string",
    "role": "super_admin|admin|reseller"
  }
}
```

Errors:
- 400: `identifier + password required`
- 401: `invalid credentials`
- 403: `admin disabled`
- 500: `internal error`

### POST /v1/admin/auth/reset/request
Sends a password reset email (no admin key required).

Body:
```json
{ "email": "user@example.com" }
```

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `email required`
- 500: `email not configured` or `missing ADMIN_RESET_BASE_URL`

### POST /v1/admin/auth/reset/confirm
Confirms a reset token and sets a new password (no admin key required).

Body:
```json
{
  "token": "string",
  "password": "string"
}
```

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `token + password required` or `password too short` or `invalid token` or `token expired`
- 500: `internal error`

### GET /v1/admin/admins
Lists admin users (super admin only).

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Query:
- `role` (optional: `super_admin|admin|reseller`)

Response 200:
```json
{ "admins": [] }
```

### POST /v1/admin/admins
Creates an admin user (super admin only).

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Body:
```json
{
  "name": "string",
  "username": "string",
  "email": "string",
  "role": "super_admin|admin|reseller",
  "password": "string"
}
```

Response 200:
```json
{ "ok": true }
```

### PATCH /v1/admin/admins/:id
Updates an admin user (super admin only).

Headers:
- `x-admin-key: <ADMIN_API_KEY>`

Body:
```json
{
  "name": "string",
  "username": "string",
  "email": "string",
  "role": "super_admin|admin|reseller",
  "status": "active|disabled"
}
```

Response 200:
```json
{ "ok": true }
```

Errors:
- 400: `invalid admin id` or `invalid role` or `invalid status` or `no fields to update`
- 404: `admin not found`
- 409: `admin already exists`
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
      "customer_name": "string",
      "customer_phone": "string",
      "status": "pending|active|suspended",
      "platform": "string",
      "model": "string",
      "app_version": "string",
      "reseller_admin_id": 2,
      "reseller_name": "string",
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
  "customer_phone": "string",
  "status": "pending|active|suspended",
  "max_streams": 1,
  "expires_at": "2025-01-01T00:00:00Z",
  "reseller_admin_id": 2
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

### DELETE /v1/admin/devices/:code
Deletes a device (and its access/upstream/analytics records).

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
- `XUI_BASE_URL` (fallback upstream base URL)
- `PLAYBACK_BASE_URL` (public base URL for playback links)
- `PLAYBACK_TOKEN_TTL` (seconds, default 3600)
- `ADMIN_RESET_BASE_URL` (public URL for reset page)
- `ADMIN_RESET_TOKEN_TTL` (seconds, default 3600)
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (true/false)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Database Schema (MySQL)
Tables:
- `devices`
- `device_access`
- `device_upstream`

View:
- `v_admin_devices`
