/** =========================================
 *  UTILS: Device code generator (CommonJS)
 *  ========================================= */
function makeDeviceCode() {
  // Example: 6-char uppercase + digits, adjust as needed
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = { makeDeviceCode };