const { pool } = require('../src/db/pool.cjs');
const { cleanupDeviceTransfers } = require('../src/utils/deviceTransferCleanup.cjs');
(async () => {
  try {
    const totals = { deleted: 0, preserved: 0 };
    for (let batch = 0; batch < 100; batch++) {
      const result = await cleanupDeviceTransfers(pool);
      totals.deleted += result.deleted; totals.preserved += result.preserved;
      if (result.deleted + result.preserved < 50) break;
    }
    console.log(JSON.stringify(totals));
  } catch (error) { console.error('Device transfer cleanup failed:', error.code || 'cleanup_failed'); process.exitCode = 1; }
  finally { await pool.end(); }
})();
