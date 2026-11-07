const mysql = require("mysql2/promise");
const { env } = require("../config/env.cjs");
const { managePool, bounded } = require('./managedPool.cjs');

const pool = managePool(mysql.createPool({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  port: Number(env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: bounded(process.env.DB_POOL_QUEUE_LIMIT, 100, 1, 1000),
}), { acquireTimeoutMs: bounded(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS, 5000, 100, 30000) });

module.exports = { pool };
