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