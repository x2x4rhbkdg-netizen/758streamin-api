CREATE TABLE IF NOT EXISTS device_code_transfers (
  retained_device_id BIGINT UNSIGNED NOT NULL,
  active_device_id BIGINT UNSIGNED NOT NULL,
  retained_code VARCHAR(32) NOT NULL,
  retained_uuid CHAR(36) NOT NULL,
  previous_record_enc MEDIUMTEXT NOT NULL,
  delete_after DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (retained_device_id),
  KEY ix_device_code_transfer_expiry (delete_after),
  CONSTRAINT fk_retained_transfer_device FOREIGN KEY (retained_device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
