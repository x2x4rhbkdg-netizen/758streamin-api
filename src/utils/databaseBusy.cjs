function isDatabaseBusy(error) {
  return ['DB_POOL_BUSY', 'DB_POOL_UNAVAILABLE', 'ER_CON_COUNT_ERROR',
    'ER_TOO_MANY_USER_CONNECTIONS'].includes(error?.code);
}
function sendDatabaseBusy(res) {
  res.setHeader('Retry-After', '5');
  return res.status(503).json({ error: 'Service temporarily busy. Please try again.', code: 'DATABASE_BUSY' });
}
module.exports = { isDatabaseBusy, sendDatabaseBusy };
