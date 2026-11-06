-- Run once in the API database before restarting the API.
CREATE TABLE IF NOT EXISTS api_background_jobs (
  job_name VARCHAR(64) NOT NULL PRIMARY KEY,
  next_run_at DATETIME NOT NULL,
  last_success_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO api_background_jobs (job_name, next_run_at)
VALUES ('whmcs-status', UTC_TIMESTAMP());
