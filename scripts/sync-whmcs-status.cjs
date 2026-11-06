const { pool } = require('../src/db/pool.cjs');
const { env } = require('../src/config/env.cjs');
const { createWhmcsStatusSync } = require('../src/utils/whmcsStatusSync.cjs');
async function main() {
  try {
    const result = await createWhmcsStatusSync({ pool, env }).run();
    if (!result.skipped) console.log(JSON.stringify(result));
  } catch { process.exitCode = 1; }
  finally { await pool.end(); }
}
void main();
