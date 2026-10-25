const { assertUnusedPending } = require('./replaceDeviceCode.cjs');
async function cleanupDeviceTransfers(db) {
  const connection = await db.getConnection();
  const result = { deleted: 0, preserved: 0 };
  try {
    await connection.beginTransaction();
    const [jobs] = await connection.execute('SELECT * FROM device_code_transfers WHERE delete_after<=UTC_TIMESTAMP() ORDER BY retained_device_id LIMIT 50 FOR UPDATE');
    for (const job of jobs) {
      const [rows] = await connection.execute('SELECT * FROM devices WHERE id=? FOR UPDATE', [job.retained_device_id]);
      const device = rows[0];
      let removable = device && String(device.id) !== String(job.active_device_id) && device.device_code === job.retained_code && device.device_uuid === job.retained_uuid;
      if (removable) {
        try { await assertUnusedPending(connection, device, device); }
        catch (error) { if (error.status !== 409) throw error; removable = false; }
      }
      if (removable) {
        await connection.execute('DELETE FROM devices WHERE id=? AND device_code=? AND device_uuid=? AND status=\'pending\'', [device.id, job.retained_code, job.retained_uuid]);
        result.deleted++;
      } else result.preserved++;
      await connection.execute('DELETE FROM device_code_transfers WHERE retained_device_id=?', [job.retained_device_id]);
    }
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}
function startDeviceTransferCleanup(db) {
  let running = false, warnedMissing = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await cleanupDeviceTransfers(db); }
    catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE' || !warnedMissing) console.warn('[device-transfer-cleanup]', error.code || 'cleanup_failed');
      warnedMissing = error.code === 'ER_NO_SUCH_TABLE';
    } finally { running = false; }
  };
  void run();
  const timer = setInterval(run, 60000); timer.unref();
  return () => clearInterval(timer);
}
module.exports = { cleanupDeviceTransfers, startDeviceTransferCleanup };
