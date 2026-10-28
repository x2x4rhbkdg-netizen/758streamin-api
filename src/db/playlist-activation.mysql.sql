-- Run once against the StreamIN database before deploying playlist activation.
-- Idempotent on MySQL versions without ADD COLUMN IF NOT EXISTS.
SET @playlist_mode_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE()
    AND table_name='device_access' AND column_name='activation_mode'),
  'SELECT 1',
  'ALTER TABLE device_access ADD COLUMN activation_mode VARCHAR(20) NOT NULL DEFAULT ''provider'''
);
PREPARE playlist_mode_statement FROM @playlist_mode_sql;
EXECUTE playlist_mode_statement;
DEALLOCATE PREPARE playlist_mode_statement;
