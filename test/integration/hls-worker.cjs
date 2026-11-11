"use strict";

// Test-only preloader. Every child runs the real app, router, JWT middleware,
// credential decryption and managed mysql2 pool. Only upstream networking is local.
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.DB_HOST, "127.0.0.1");
assert.match(process.env.DB_NAME, /^hls_process_test_/);
assert.equal(process.env.DISABLE_BACKGROUND_JOBS, "1");
const upstream = process.env.HLS_TEST_UPSTREAM;
assert.equal(new URL(upstream).hostname, "127.0.0.1");

const assetModule = require("../../src/utils/playbackAssetHttp.cjs");
const createReader = assetModule.createPlaybackAssetReader;
const assetRequests = [];
assetModule.createPlaybackAssetReader = () => createReader({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  requestHttp(url, options, callback) {
    assetRequests.push(url.pathname);
    return http.get(new URL(url.pathname + url.search, upstream), {
      headers: options.headers, signal: options.signal, agent: false,
    }, callback);
  },
});
const realFetch = global.fetch;
global.fetch = async (value, init) => {
  const target = new URL(value);
  assert.equal(target.origin, "http://upstream.example", "Unexpected external upstream request");
  const response = await realFetch(new URL(target.pathname + target.search, upstream), init);
  const final = new URL(response.url);
  return { ok: response.ok, status: response.status, headers: response.headers,
    url: new URL(final.pathname + final.search, target.origin).href, text: () => response.text() };
};

const routeFile = require.resolve("../../src/routes/playback.routes.cjs");
const route = new Module(routeFile, module);
route.filename = routeFile;
route.paths = Module._nodeModulePaths(path.dirname(routeFile));
require.cache[routeFile] = route;
route._compile(fs.readFileSync(routeFile, "utf8") + `\nmodule.exports.testHooks = {
  cache: playbackAssetCacheById,
  seedLegacy(token, url, expiresAtMs) {
    const assetId = randomUUID();
    playbackAssetCacheById.set(assetId, { assetId, playbackToken: token, targetUrl: url,
      expiresAtMs, touchedAt: Date.now() });
    return assetId;
  }
};`, routeFile);

const { pool } = require("../../src/db/pool.cjs");
let connections = 0, maxCheckedOut = 0, authorizationReads = 0;
pool.on("connection", () => { connections++; });
pool.on("acquire", () => { maxCheckedOut = Math.max(maxCheckedOut, pool.pressureSnapshot().checkedOut); });
const execute = pool.execute.bind(pool);
pool.execute = (...args) => {
  if (/SELECT d\.status/.test(args[0])) authorizationReads++;
  return execute(...args);
};
const held = [];
const server = require("../../src/server.js");
server.on("listening", () => process.send({ ready: true, pid: process.pid, port: server.address().port }));
process.on("message", async message => {
  try {
    let result;
    switch (message.command) {
      case "stats":
        result = { pid: process.pid, connections, maxCheckedOut, authorizationReads,
          ...pool.pressureSnapshot(), assets: route.exports.testHooks.cache.size,
          assetRequests: assetRequests.length };
        break;
      case "hold":
        for (let i = 0; i < 10; i++) held.push(await pool.getConnection());
        result = held.length;
        break;
      case "release":
        held.splice(0).forEach(connection => connection.release());
        result = true;
        break;
      case "legacy":
        result = route.exports.testHooks.seedLegacy(message.token,
          "http://upstream.example/segment.ts", Date.now() + 60000);
        break;
      default: throw new Error("Unknown test command");
    }
    process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: error.code || error.message }); }
});
