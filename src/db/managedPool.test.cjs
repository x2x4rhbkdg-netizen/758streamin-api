const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { managePool } = require('./managedPool.cjs');
function fixture(checkout) {
  const pool = new EventEmitter();
  pool.getConnection = checkout;
  pool.end = async () => {};
  return managePool(pool, { acquireTimeoutMs: 10 });
}
test('queries and failed queries always release their connection', async () => {
  let releases = 0;
  const pool = fixture(async () => ({ execute: async () => [1], query: async () => { throw new Error('bad query'); }, release() { releases++; } }));
  assert.deepEqual(await pool.execute('select fixture'), [1]);
  await assert.rejects(pool.query('bad fixture'), /bad query/);
  assert.equal(releases, 2); assert.equal(pool.pressureSnapshot().pending, 0);
  await pool.end();
});
test('acquisition timeout rejects and releases a late connection without running SQL', async () => {
  let giveConnection, releases = 0;
  const pool = fixture(() => new Promise(resolve => { giveConnection = resolve; }));
  await assert.rejects(pool.execute('must not run'), { code: 'DB_POOL_BUSY' });
  giveConnection({ release() { releases++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1); assert.equal(pool.pressureSnapshot().pending, 0);
  assert.equal(pool.pressureSnapshot().timedOut, 1);
  await pool.end();
});
test('queue overflow is retryable, not an authentication failure', async () => {
  const pool = fixture(async () => { throw new Error('Queue limit reached.'); });
  await assert.rejects(pool.getConnection(), { code: 'DB_POOL_BUSY' });
  assert.equal(pool.pressureSnapshot().rejected, 1);
  await pool.end();
});

test('transaction checkouts remain caller-owned until finally release', async () => {
  let releases = 0;
  const connection = { beginTransaction: async () => {}, rollback: async () => {}, release() { releases++; } };
  const pool = fixture(async () => connection);
  const checkedOut = await pool.getConnection();
  assert.equal(releases, 0);
  try { await checkedOut.beginTransaction(); throw new Error('rollback fixture'); }
  catch { await checkedOut.rollback(); }
  finally { checkedOut.release(); }
  assert.equal(releases, 1); await pool.end();
});

test('read-only failures discard the connection just as mysql2 pool.execute does', async () => {
  let destroyed = 0, released = 0;
  const pool = fixture(async () => ({ execute: async () => { const error = new Error('read only'); error.errno = 1290; throw error; },
    destroy() { destroyed++; }, release() { released++; } }));
  await assert.rejects(pool.execute('write fixture'), /read only/);
  assert.equal(destroyed, 1); assert.equal(released, 1); await pool.end();
});

test('pressure logging reports counters only and stops when the pool closes', async () => {
  const logs = [];
  const raw = new EventEmitter(); raw.end = async () => {};
  raw.getConnection = async () => { throw new Error('Queue limit reached.'); };
  const pool = managePool(raw, { monitorMs: 5, logger: { warn: (...args) => logs.push(args) } });
  raw.emit('enqueue');
  await assert.rejects(pool.getConnection());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(logs.length >= 1);
  assert.equal(logs[0][0], '[mysql-pool]');
  assert.deepEqual(Object.keys(logs[0][1]).sort(), ['pending', 'acquired', 'timedOut', 'rejected', 'enqueued', 'checkedOut'].sort());
  await pool.end(); const count = logs.length;
  raw.emit('enqueue'); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(logs.length, count);
});
