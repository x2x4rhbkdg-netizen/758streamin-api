function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? Math.min(max, Math.floor(number)) : fallback;
}

function busyError() {
  const error = new Error('Database temporarily busy');
  error.code = 'DB_POOL_BUSY';
  return error;
}

function databaseError(error) {
  if (['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(error?.code)) {
    const unavailable = new Error('Database temporarily unavailable');
    unavailable.code = 'DB_POOL_UNAVAILABLE';
    return unavailable;
  }
  return error;
}

function managePool(pool, { acquireTimeoutMs = 5000, logger = console, monitorMs = 60000 } = {}) {
  const checkout = pool.getConnection.bind(pool);
  const checkedOut = new Set();
  const stats = { pending: 0, acquired: 0, timedOut: 0, rejected: 0, enqueued: 0 };
  pool.on('acquire', connection => checkedOut.add(connection));
  pool.on('release', connection => checkedOut.delete(connection));
  pool.on('connection', connection => connection.on('end', () => checkedOut.delete(connection)));
  pool.on('enqueue', () => { stats.enqueued++; });

  pool.getConnection = () => new Promise((resolve, reject) => {
    stats.pending++;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true; stats.timedOut++; stats.pending--; reject(busyError());
    }, acquireTimeoutMs);
    checkout().then(connection => {
      if (settled) { connection.release(); return; }
      settled = true; clearTimeout(timer); stats.pending--; stats.acquired++;
      resolve(connection);
    }, error => {
      if (settled) return;
      settled = true; clearTimeout(timer); stats.pending--; stats.rejected++;
      reject(error.message === 'Queue limit reached.' || error.message === 'Pool is closed.' ? busyError() : databaseError(error));
    });
  });
  // All query paths use the same bounded acquisition and release on success/error.
  for (const method of ['execute', 'query']) {
    pool[method] = async (...args) => {
      const connection = await pool.getConnection();
      try { return await connection[method](...args); }
      catch (error) {
        if ([1792, 1290, 1836].includes(error?.errno)) connection.destroy();
        throw databaseError(error);
      }
      finally { connection.release(); }
    };
  }
  pool.pressureSnapshot = () => ({ ...stats, checkedOut: checkedOut.size });
  let previous = { timedOut: 0, rejected: 0, enqueued: 0 };
  const timer = setInterval(() => {
    const snapshot = pool.pressureSnapshot();
    if (snapshot.pending || ['timedOut', 'rejected', 'enqueued'].some(key => snapshot[key] !== previous[key])) {
      logger.warn('[mysql-pool]', snapshot);
    }
    previous = snapshot;
  }, monitorMs);
  timer.unref();
  const end = pool.end.bind(pool);
  pool.end = async () => { clearInterval(timer); return end(); };
  return pool;
}
module.exports = { managePool, bounded };
