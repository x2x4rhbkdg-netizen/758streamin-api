-- Run in the StreamIN database before deploying device-targeted app updates.
-- Zero means all devices. No foreign key: release history survives device deletion.
SET @update_target_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_schema=DATABASE() AND table_name='app_updates' AND column_name='target_device_id'),
  'SELECT 1', 'ALTER TABLE app_updates ADD COLUMN target_device_id BIGINT UNSIGNED NOT NULL DEFAULT 0');
PREPARE update_target_stmt FROM @update_target_sql;
EXECUTE update_target_stmt;
DEALLOCATE PREPARE update_target_stmt;

SET @update_target_sql = IF(EXISTS(SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='app_updates' AND index_name='uq_app_updates_scope_version' AND column_name='target_device_id'),
  'SELECT 1', IF(EXISTS(SELECT 1 FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='app_updates' AND index_name='uq_app_updates_scope_version'),
    'ALTER TABLE app_updates DROP INDEX uq_app_updates_scope_version, ADD UNIQUE KEY uq_app_updates_scope_version (channel, platform, version_code, target_device_id)',
    'ALTER TABLE app_updates ADD UNIQUE KEY uq_app_updates_scope_version (channel, platform, version_code, target_device_id)'));
PREPARE update_target_stmt FROM @update_target_sql;
EXECUTE update_target_stmt;
DEALLOCATE PREPARE update_target_stmt;
