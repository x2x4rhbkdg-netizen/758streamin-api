/** =========================================
 *  PASSENGER ENTRYPOINT (must listen)
 *  ========================================= */
const app = require("./app");

const port = Number(process.env.PORT || 3000);
const host = process.env.IP || "127.0.0.1"; // Passenger commonly uses 127.0.0.1

const server = app.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port}`);
});

/** =========================================
 *  CRASH VISIBILITY (so Passenger logs it)
 *  ========================================= */
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

module.exports = server;

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.stopBackgroundJobs();
  // Bound drain time: a long-running video proxy must not block worker shutdown.
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  server.close(async () => {
    try { await require('./db/pool.cjs').pool.end(); }
    catch (error) { console.error('[shutdown]', error.code || 'pool_close_failed'); }
    finally { clearTimeout(deadline); process.exit(0); }
  });
});
