-- Run in phpMyAdmin's SQL tab on the StreamIN database BEFORE deploying the API.
-- Existing update records retain their universal APK URL and require no edits.
SET @apk_variant_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_schema=DATABASE() AND table_name='app_updates' AND column_name='apk_variants'),
  'SELECT 1', 'ALTER TABLE app_updates ADD COLUMN apk_variants MEDIUMTEXT NULL');
PREPARE apk_variant_stmt FROM @apk_variant_sql;
EXECUTE apk_variant_stmt;
DEALLOCATE PREPARE apk_variant_stmt;
