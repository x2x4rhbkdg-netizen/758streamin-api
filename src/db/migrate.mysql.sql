/****************************************
 *  MYSQL SCHEMA: 758 Streamin API
 *  ========================================= */

CREATE TABLE IF NOT EXISTS admins (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(120) NULL,
  username     VARCHAR(64) NULL,
  email        VARCHAR(190) NULL,
  role         ENUM('super_admin','admin','reseller') NOT NULL DEFAULT 'admin',
  status       ENUM('active','disabled') NOT NULL DEFAULT 'active',
  password_hash TEXT NOT NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  last_login_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_username (username),
  UNIQUE KEY uq_admin_email (email),
  KEY idx_admin_role (role),
  CONSTRAINT fk_admin_creator
    FOREIGN KEY (created_by_admin_id) REFERENCES admins(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_password_resets (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id     BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_admin_resets_admin (admin_id),
  KEY idx_admin_resets_token (token_hash),
  CONSTRAINT fk_admin_resets_admin
    FOREIGN KEY (admin_id) REFERENCES admins(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS devices (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_uuid  CHAR(36) NOT NULL,
  device_code  VARCHAR(32) NOT NULL,
  customer_name VARCHAR(255) NULL,
  customer_phone VARCHAR(32) NULL,
  status       ENUM('pending','active','suspended') NOT NULL DEFAULT 'pending',
  platform     VARCHAR(64) NULL,
  model        VARCHAR(128) NULL,
  app_version  VARCHAR(32) NULL,
  reseller_admin_id BIGINT UNSIGNED NULL,
  last_seen_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_uuid (device_uuid),
  UNIQUE KEY uq_device_code (device_code),
  KEY idx_devices_status (status),
  KEY idx_devices_reseller (reseller_admin_id),
  CONSTRAINT fk_devices_reseller
    FOREIGN KEY (reseller_admin_id) REFERENCES admins(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_access (
  device_id   BIGINT UNSIGNED NOT NULL,
  expires_at  DATETIME NULL,
  max_streams INT NOT NULL DEFAULT 1,
  notes       TEXT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  CONSTRAINT fk_access_device
    FOREIGN KEY (device_id) REFERENCES devices(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_upstream (
  device_id         BIGINT UNSIGNED NOT NULL,
  upstream_base_url TEXT NOT NULL,
  enc_username      TEXT NOT NULL,
  enc_password      TEXT NOT NULL,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  CONSTRAINT fk_upstream_device
    FOREIGN KEY (device_id) REFERENCES devices(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analytics_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id        BIGINT UNSIGNED NOT NULL,
  event_type       VARCHAR(32) NOT NULL,
  content_id       VARCHAR(64) NULL,
  content_type     VARCHAR(16) NULL,
  position_seconds INT NULL,
  duration_seconds INT NULL,
  error_code       VARCHAR(64) NULL,
  meta_json        TEXT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_analytics_device (device_id),
  KEY idx_analytics_type (event_type),
  CONSTRAINT fk_analytics_device
    FOREIGN KEY (device_id) REFERENCES devices(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

/** =========================================
 *  VIEW: Admin Devices (dashboard-friendly)
 *  ========================================= */
CREATE OR REPLACE VIEW v_admin_devices AS
SELECT
  d.id,
  d.device_uuid,
  d.device_code      AS code,
  d.customer_name,
  d.status,
  d.platform,
  d.model,
  d.app_version      AS app,
  d.reseller_admin_id AS reseller_id,
  a.name             AS reseller_name,
  da.max_streams,
  d.last_seen_at,
  d.created_at       AS created,
  d.updated_at
FROM devices d
LEFT JOIN admins a
  ON a.id = d.reseller_admin_id
LEFT JOIN device_access da
  ON da.device_id = d.id;

/** =========================================
 *  TABLE: App Updates (direct/sideload + store channels)
 *  ========================================= */
CREATE TABLE IF NOT EXISTS app_updates (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel            ENUM('direct','play','amazon') NOT NULL DEFAULT 'direct',
  platform           VARCHAR(32) NOT NULL DEFAULT 'android_tv',
  version_code       INT UNSIGNED NOT NULL,
  version_name       VARCHAR(64) NOT NULL,
  apk_url            TEXT NOT NULL,
  sha256             CHAR(64) NULL,
  force_update       TINYINT(1) NOT NULL DEFAULT 0,
  status             ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes              TEXT NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_updates_scope_version (channel, platform, version_code),
  KEY idx_app_updates_status (status),
  KEY idx_app_updates_channel_platform (channel, platform),
  KEY idx_app_updates_updated (updated_at),
  CONSTRAINT fk_app_updates_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admins(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

/** =========================================
 *  TABLE: Home Screen Ads (4 slots)
 *  - home_left + home_right lower ad row
 *  - movies + series fallback quick-slot blocks
 *  ========================================= */
CREATE TABLE IF NOT EXISTS app_home_ads (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slot_key            ENUM('home_left','home_right','movies','series') NOT NULL,
  title               VARCHAR(190) NULL,
  poster_url          TEXT NULL,
  launch_url          TEXT NULL,
  media_type          ENUM('poster','video') NOT NULL DEFAULT 'poster',
  media_url           TEXT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  starts_at           DATETIME NULL,
  ends_at             DATETIME NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_home_ads_slot (slot_key),
  KEY idx_app_home_ads_active_window (is_active, starts_at, ends_at),
  CONSTRAINT fk_app_home_ads_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admins(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE app_home_ads
  ADD COLUMN IF NOT EXISTS launch_url TEXT NULL AFTER poster_url;

ALTER TABLE app_home_ads
  MODIFY COLUMN slot_key ENUM('home_left','home_right','movies','series') NOT NULL;

/** =========================================
 *  TABLE: App Notifications
 *  ========================================= */
CREATE TABLE IF NOT EXISTS app_notifications (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title               VARCHAR(190) NOT NULL,
  message             TEXT NULL,
  image_url           TEXT NULL,
  is_ticker           TINYINT(1) NOT NULL DEFAULT 0,
  ticker_text         TEXT NULL,
  status              ENUM('active','inactive') NOT NULL DEFAULT 'active',
  target_platform     VARCHAR(32) NOT NULL DEFAULT 'all',
  starts_at           DATETIME NULL,
  ends_at             DATETIME NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_app_notifications_status (status),
  KEY idx_app_notifications_platform (target_platform),
  KEY idx_app_notifications_window (starts_at, ends_at),
  CONSTRAINT fk_app_notifications_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admins(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

/** =========================================
 *  APP NOTIFICATIONS TARGETING UPGRADE
 *  - Supports mass + single-device notifications.
 *  - If app_notifications already exists, this ALTER enables new targeting columns.
 *  ========================================= */
ALTER TABLE app_notifications
  ADD COLUMN IF NOT EXISTS image_url TEXT NULL AFTER message,
  ADD COLUMN IF NOT EXISTS is_ticker TINYINT(1) NOT NULL DEFAULT 0 AFTER image_url,
  ADD COLUMN IF NOT EXISTS ticker_text TEXT NULL AFTER is_ticker,
  ADD COLUMN IF NOT EXISTS target_scope ENUM('mass','device') NOT NULL DEFAULT 'mass' AFTER status,
  ADD COLUMN IF NOT EXISTS target_device_id BIGINT UNSIGNED NULL AFTER target_platform;

/** =========================================
 *  DEVICES: WHMCS BILLING LINK UPGRADE
 *  - Maps each device to WHMCS client/service.
 *  - Caches billing sync status for dashboard + notifications.
 *  ========================================= */
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS whmcs_client_id BIGINT UNSIGNED NULL AFTER reseller_admin_id,
  ADD COLUMN IF NOT EXISTS whmcs_service_id BIGINT UNSIGNED NULL AFTER whmcs_client_id,
  ADD COLUMN IF NOT EXISTS whmcs_billing_status VARCHAR(64) NULL AFTER whmcs_service_id,
  ADD COLUMN IF NOT EXISTS whmcs_next_due_date DATETIME NULL AFTER whmcs_billing_status,
  ADD COLUMN IF NOT EXISTS whmcs_last_sync_at DATETIME NULL AFTER whmcs_next_due_date;
