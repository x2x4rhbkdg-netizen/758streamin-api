/** =========================================
 *  UTILS: Upstream credentials (CommonJS)
 *  - Resolves upstream base + decrypted creds for a device
 *  ========================================= */
const { pool } = require("../db/pool.cjs");
const { decryptString } = require("./cryptoVault.cjs");
const { env } = require("../config/env.cjs");

async function getDeviceUpstream(deviceId) {
  const [rows] = await pool.execute(
    `SELECT upstream_base_url, enc_username, enc_password
     FROM device_upstream
     WHERE device_id=?
     LIMIT 1`,
    [deviceId]
  );

  const row = rows[0];
  if (!row) return null;

  const username = decryptString(row.enc_username);
  const password = decryptString(row.enc_password);

  const upstreamBaseUrl = row.upstream_base_url || env.XUI_BASE_URL || "";
  if (!upstreamBaseUrl) throw new Error("missing upstream base URL");

  return {
    upstream_base_url: upstreamBaseUrl,
    username,
    password,
  };
}

module.exports = { getDeviceUpstream };
