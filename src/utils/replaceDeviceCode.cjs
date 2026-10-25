const { randomBytes, randomUUID } = require('node:crypto');
const fail = (message, status) => Object.assign(new Error(message), { status });

function normalizeDeviceCode(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]{6,32}$/i.test(value.trim())) {
    throw fail('Device code must contain 6 to 32 letters or digits.', 400);
  }
  return value.trim().toUpperCase();
}
function canEditDevice(admin, device) {
  return admin?.role === 'super_admin' || (admin?.role === 'reseller' && admin.id != null &&
    device.reseller_admin_id != null && String(admin.id) === String(device.reseller_admin_id));
}
async function assertUnusedPending(connection, target, source) {
  if (target.status !== 'pending' || (target.reseller_admin_id != null && String(target.reseller_admin_id) !== String(source.reseller_admin_id)) ||
      ['customer_name', 'customer_phone', 'plan_name', 'trial_expires_at', 'whmcs_client_id', 'whmcs_service_id', 'whmcs_account_number',
        'whmcs_billing_status', 'whmcs_next_due_date', 'whmcs_last_sync_at'].some(key => target[key])) {
    throw fail('That code belongs to a configured device. Choose a fresh pending device code.', 409);
  }
  const [access] = await connection.execute('SELECT * FROM device_access WHERE device_id=? FOR UPDATE', [target.id]);
  if (access.some(row => Number(row.max_streams || 1) !== 1 || Object.entries(row).some(([key, value]) =>
    !['device_id', 'max_streams', 'updated_at'].includes(key) && value != null && value !== '' && value !== false && value !== 0))) {
    throw fail('That pending device already has account settings. Choose an unused code.', 409);
  }
  for (const table of ['device_upstream', 'analytics_events', 'device_movie_settings']) {
    try {
      const [rows] = await connection.execute(`SELECT device_id FROM ${table} WHERE device_id=? LIMIT 1 FOR UPDATE`, [target.id]);
      if (rows.length) throw fail('That pending device already has account settings. Choose an unused code.', 409);
    } catch (error) {
      if (table !== 'device_movie_settings' || error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }
  }
}
const identity = device => [device.device_uuid, device.device_code, device.platform || null, device.model || null, device.app_version || null, device.last_seen_at || null];
const writeIdentity = (connection, id, values) => connection.execute(`UPDATE devices SET device_uuid=?, device_code=?, platform=?, model=?, app_version=?, last_seen_at=?, updated_at=NOW() WHERE id=?`, [...values, id]);

async function replaceDeviceCode({ db, admin, code, newCode, encrypt = value => require('./cryptoVault.cjs').encryptString(value) }) {
  const oldCode = normalizeDeviceCode(code), nextCode = normalizeDeviceCode(newCode);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Lock both identities in a consistent order. Keep all account rows on the original device ID.
    const [rows] = await connection.execute('SELECT * FROM devices WHERE device_code IN (?, ?) ORDER BY id FOR UPDATE', [oldCode, nextCode]);
    const source = rows.find(row => String(row.device_code).toUpperCase() === oldCode);
    if (!source) throw fail('Device not found.', 404);
    if (!canEditDevice(admin, source)) throw fail('Forbidden.', 403);
    if (nextCode === oldCode) { await connection.commit(); return { ok: true, device_id: source.id, device_code: nextCode, previous_code: oldCode, transferred: false }; }
    const target = rows.find(row => String(row.device_code).toUpperCase() === nextCode && String(row.id) !== String(source.id));
    if (target) await assertUnusedPending(connection, target, source);
    const previousRecord = encrypt(JSON.stringify(source));
    let retainedId, retainedUuid;
    await connection.execute('DELETE FROM device_code_transfers WHERE retained_device_id=?', [source.id]);
    if (target) {
      const sourceIdentity = identity(source), targetIdentity = identity(target);
      // Swap identities, not accounts: the old hardware becomes the unused pending registration.
      await connection.execute('UPDATE devices SET device_uuid=?, device_code=? WHERE id=?', [randomUUID(), `MOVE${randomBytes(12).toString('hex').toUpperCase()}`, source.id]);
      await writeIdentity(connection, target.id, sourceIdentity);
      await writeIdentity(connection, source.id, targetIdentity);
      retainedId = target.id; retainedUuid = sourceIdentity[0];
    } else {
      await connection.execute('UPDATE devices SET device_code=?, updated_at=NOW() WHERE id=?', [nextCode, source.id]);
      retainedUuid = randomUUID();
      const [created] = await connection.execute(`INSERT INTO devices
        (device_uuid, device_code, status, platform, model, app_version, reseller_admin_id, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, NOW(), NOW())`,
      [retainedUuid, oldCode, source.platform || null, source.model || null, source.app_version || null, source.reseller_admin_id || null]);
      retainedId = created.insertId;
    }
    await connection.execute(`INSERT INTO device_code_transfers
      (retained_device_id, active_device_id, retained_code, retained_uuid, previous_record_enc, delete_after)
      VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))
      ON DUPLICATE KEY UPDATE active_device_id=VALUES(active_device_id), retained_code=VALUES(retained_code),
      retained_uuid=VALUES(retained_uuid), previous_record_enc=VALUES(previous_record_enc), delete_after=VALUES(delete_after), created_at=NOW()`,
    [retainedId, source.id, oldCode, retainedUuid, previousRecord]);
    await connection.commit();
    return { ok: true, device_id: source.id, device_code: nextCode, previous_code: oldCode, transferred: Boolean(target), retention_hours: 24 };
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY' || error.code === 'ER_LOCK_DEADLOCK') throw fail('The device code changed in another session. Refresh and try again.', 409);
    throw error;
  } finally { connection.release(); }
}
module.exports = { normalizeDeviceCode, replaceDeviceCode, assertUnusedPending };
