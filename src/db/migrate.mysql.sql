/** =========================================
 *  MYSQL SCHEMA: 758 Streamin API
 *  ========================================= */

CREATE TABLE IF NOT EXISTS devices (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_uuid  CHAR(36) NOT NULL,
  device_code  VARCHAR(32) NOT NULL,
  status       ENUM('pending','active','suspended') NOT NULL DEFAULT 'pending',
  platform     VARCHAR(64) NULL,
  model        VARCHAR(128) NULL,
  app_version  VARCHAR(32) NULL,
  last_seen_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_uuid (device_uuid),
  UNIQUE KEY uq_device_code (device_code),
  KEY idx_devices_status (status)
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