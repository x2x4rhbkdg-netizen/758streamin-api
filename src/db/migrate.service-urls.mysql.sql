CREATE TABLE IF NOT EXISTS service_urls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  url VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY service_urls_url_unique (url),
  KEY service_urls_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Device URLs remain stored in device_upstream; editing or deleting a directory
-- entry does not change an existing device's playback configuration.
