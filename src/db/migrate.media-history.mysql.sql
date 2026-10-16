CREATE TABLE IF NOT EXISTS media_history (
  owner_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  section VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entry_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entry_enc MEDIUMTEXT NOT NULL,
  progress_updated_at BIGINT UNSIGNED NOT NULL,
  saved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key, section, entry_key),
  KEY ix_media_history_recent (owner_key, section, progress_updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
