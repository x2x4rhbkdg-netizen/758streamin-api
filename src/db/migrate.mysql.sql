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
