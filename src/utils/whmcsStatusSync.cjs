const JOB = 'whmcs-status';
const LOCK = 'streamin-whmcs-status';

function matchingDeviceStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return status === 'active' || status === 'suspended' ? status : null;
}

// Retrieve service statuses in pages, not one full customer/credential sync per device.
async function fetchServiceStatuses(env, serviceIds, fetcher = fetch) {
  const wanted = new Set(serviceIds.map(String));
  const statuses = new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      const body = new URLSearchParams({ action: 'GetClientsProducts',
        identifier: env.WHMCS_API_IDENTIFIER, secret: env.WHMCS_API_SECRET,
        responsetype: 'json', limitstart: String(offset), limitnum: '250' });
      const response = await fetcher(env.WHMCS_API_URL, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'streamin-api/1.0' },
        body: body.toString(), signal: controller.signal });
      if (!response.ok) throw new Error('WHMCS status request failed');
      const data = await response.json();
      if (String(data?.result).toLowerCase() !== 'success') throw new Error('WHMCS status response failed');
      const products = data?.products?.product;
      const rows = Array.isArray(products) ? products : products && typeof products === 'object' ? [products] : [];
      for (const product of rows) {
        const id = String(product?.id || product?.serviceid || '');
        if (wanted.has(id)) statuses.set(id, matchingDeviceStatus(product.status));
      }
      offset += rows.length;
      if (statuses.size === wanted.size || offset >= Number(data.totalresults) || !rows.length) return statuses;
      if (!Number.isFinite(Number(data.totalresults))) throw new Error('WHMCS status pagination missing');
    }
    throw new Error('WHMCS status scan exceeded page limit');
  } finally { clearTimeout(timer); }
}

function createWhmcsStatusSync({ pool, env, fetcher = fetch, logger = console }) {
  const interval = Math.max(60, Math.min(3600, Number(env.WHMCS_STATUS_INTERVAL_SECONDS) || 300));
  let running = false, warnedMissing = false;
  async function run() {
    if (running || !env.WHMCS_API_URL || !env.WHMCS_API_IDENTIFIER || !env.WHMCS_API_SECRET) return { skipped: true };
    running = true;
    let connection, locked = false, claimed = false;
    try {
      connection = await pool.getConnection();
      const [lock] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [LOCK]);
      if (Number(lock[0]?.acquired) !== 1) return { skipped: true };
      locked = true;
      // The due time survives Passenger restarts and is shared by all API workers.
      const [claim] = await connection.execute(`UPDATE api_background_jobs
        SET next_run_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
        WHERE job_name=? AND next_run_at<=UTC_TIMESTAMP()`, [interval, JOB]);
      if (!claim.affectedRows) return { skipped: true };
      claimed = true;
      const [devices] = await connection.execute(`SELECT DISTINCT whmcs_service_id FROM devices
        WHERE whmcs_service_id>0 AND status IN ('active', 'suspended')`);
      const ids = devices.map(row => String(row.whmcs_service_id));
      const statuses = ids.length ? await fetchServiceStatuses(env, ids, fetcher) : new Map();
      let changed = 0;
      // Only changed states are written; unknown/missing/failed services are never suspended.
      for (const status of ['active', 'suspended']) {
        const matching = [...statuses].filter(([, state]) => state === status).map(([id]) => id);
        for (let offset = 0; offset < matching.length; offset += 250) {
          const batch = matching.slice(offset, offset + 250);
          const billing = status === 'active' ? 'Active' : 'Suspended';
          const [result] = await connection.execute(`UPDATE devices SET status=?, whmcs_billing_status=?, updated_at=NOW()
            WHERE whmcs_service_id IN (${batch.map(() => '?').join(',')})
              AND status IN ('active', 'suspended')
              AND (status<>? OR NOT (whmcs_billing_status <=> ?))`, [status, billing, ...batch, status, billing]);
          changed += Number(result.affectedRows || 0);
        }
      }
      await connection.execute(`UPDATE api_background_jobs SET last_success_at=UTC_TIMESTAMP(),
        next_run_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE job_name=?`, [interval, JOB]);
      return { checked: ids.length, found: statuses.size, changed };
    } catch (error) {
      if (claimed && connection) await connection.execute(`UPDATE api_background_jobs
        SET next_run_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE job_name=?`, [interval, JOB]).catch(() => {});
      if (error.code !== 'ER_NO_SUCH_TABLE' || !warnedMissing) logger.warn('[whmcs-status]', error.code || 'status_check_failed');
      warnedMissing = error.code === 'ER_NO_SUCH_TABLE';
      throw error;
    } finally {
      if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
      connection?.release(); running = false;
    }
  }
  function start() {
    const tick = () => { void run().catch(() => {}); };
    tick();
    const timer = setInterval(tick, 60000); timer.unref();
    return () => clearInterval(timer);
  }
  return { run, start };
}
module.exports = { createWhmcsStatusSync, fetchServiceStatuses, matchingDeviceStatus };
