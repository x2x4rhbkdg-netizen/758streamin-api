/** =========================================
 *  PASSENGER: Startup (CommonJS)
 *  ========================================= */
const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"), // /api.758streamin.com/.env
});

module.exports = require("./server.js");