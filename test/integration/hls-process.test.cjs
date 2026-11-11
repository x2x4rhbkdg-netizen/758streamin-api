"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { fork, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomBytes, createCipheriv } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const mysql = require("mysql2/promise");
const jwt = require("jsonwebtoken");
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const SEGMENT = Buffer.from([0, 255, 42, 128, 10, 13, 65, 0, 99]);
const KEY = Buffer.from("0123456789abcdef");
const ORIGIN = "http://upstream.example";
const mediaLinks = text => text.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
const rehost = (link, base) => { const url = new URL(link); return new URL(url.pathname + url.search, base); };

function encrypt(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(part => part.toString("base64")).join(".");
}

async function startWorker(env, workers) {
  const child = fork(path.join(__dirname, "hls-worker.cjs"), [], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const pending = new Map();
  let seq = 0, output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-8000); });
  const worker = { child, base: "", pid: child.pid,
    rpc(command, values = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker ${command} timed out`)); }, 10000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.send({ id, command, ...values });
      });
    },
    async stop(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = once(child, "exit");
      child.kill(signal);
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(deadline); }
    },
  };
  workers.push(worker);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${output}`)), 15000);
    const fail = () => { clearTimeout(timer); reject(new Error(`Worker exited before ready: ${output}`)); };
    child.once("exit", fail);
    child.once("error", reject);
    child.on("message", message => {
      if (message.ready) {
        clearTimeout(timer); child.removeListener("exit", fail);
        worker.base = `http://127.0.0.1:${message.port}`;
        resolve();
      } else if (pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      }
    });
    child.on("exit", () => {
      for (const request of pending.values()) request.reject(new Error("Worker exited"));
      pending.clear();
    });
  });
  return worker;
}

test("HLS through independent complete API processes and disposable MariaDB", { timeout: 120000 }, async t => {
  const workers = [];
  const proxies = [];
  let container, db, upstream;
  t.after(async () => {
    for (const proxy of proxies) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    for (const worker of workers) await worker.stop();
    if (db) await db.end();
    if (upstream) await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    if (container) await exec("docker", ["stop", "--time", "3", container]);
  });
  const suffix = randomBytes(6).toString("hex"), password = randomBytes(24).toString("hex");
  const database = `hls_process_test_${suffix}`;
  const image = process.env.HLS_TEST_MARIADB_IMAGE || "mariadb:11.4";
  container = (await exec("docker", ["run", "--detach", "--rm", "--name", `streamin-hls-test-${suffix}`,
    "--publish", "127.0.0.1::3306", "--env", `MARIADB_ROOT_PASSWORD=${password}`,
    "--env", `MARIADB_DATABASE=${database}`, "--env", "MARIADB_USER=hls_test",
    "--env", `MARIADB_PASSWORD=${password}`, image, "--max-connections=50"])).stdout.trim();
  const address = (await exec("docker", ["port", container, "3306/tcp"])).stdout.trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const port = Number(address.split(":").at(-1));
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      db = await mysql.createConnection({ host: "127.0.0.1", port, user: "hls_test", password, database, connectTimeout: 1000 });
      break;
    } catch (error) { if (attempt === 119) throw error; await delay(500); }
  }
  const [[version]] = await db.query("SELECT VERSION() AS version");
  assert.match(version.version, /MariaDB/i);
  t.diagnostic(`Database: ${version.version}`);
  // Only the columns read by the playback/auth routes are needed in this fixture.
  await db.query("CREATE TABLE devices (id BIGINT PRIMARY KEY, device_code VARCHAR(32), status VARCHAR(20), platform VARCHAR(64), last_seen_at DATETIME)");
  await db.query("CREATE TABLE device_access (device_id BIGINT PRIMARY KEY, activation_mode VARCHAR(20), expires_at DATETIME, max_streams INT)");
  await db.query("CREATE TABLE device_upstream (device_id BIGINT PRIMARY KEY, upstream_base_url TEXT, enc_username TEXT, enc_password TEXT)");
  const encKey = randomBytes(32), secret = randomBytes(32).toString("hex");
  for (const id of [7, 8]) {
    await db.execute("INSERT INTO devices VALUES (?, ?, 'active', 'web', NULL)", [id, `TEST${id}`]);
    await db.execute("INSERT INTO device_access VALUES (?, 'provider', DATE_ADD(NOW(), INTERVAL 1 DAY), 2)", [id]);
    await db.execute("INSERT INTO device_upstream VALUES (?, ?, ?, ?)", [id, ORIGIN, encrypt("user", encKey), encrypt("password", encKey)]);
  }
  const upstreamCalls = [];
  upstream = http.createServer((req, res) => {
    upstreamCalls.push(req.url);
    const url = new URL(req.url, ORIGIN);
    const fixtures = {
      "/live/user/password/100.m3u8": ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n/variant.m3u8', "application/vnd.apple.mpegurl"],
      "/variant.m3u8": ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:6,\n/segment.ts\n', "application/vnd.apple.mpegurl"],
      "/key": [KEY, "application/octet-stream"], "/segment.ts": [SEGMENT, "video/mp2t"],
    };
    const fixture = fixtures[url.pathname];
    if (!fixture) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": fixture[1] }); res.end(fixture[0]);
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  // Build a clean environment instead of inheriting production credentials.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", USE_DOTENV: "0",
    PORT: "0", IP: "127.0.0.1", DISABLE_BACKGROUND_JOBS: "1", JWT_SECRET: secret,
    ADMIN_API_KEY: "integration-test-only", ENC_KEY_BASE64: encKey.toString("base64"),
    DB_HOST: "127.0.0.1", DB_PORT: String(port), DB_USER: "hls_test", DB_PASSWORD: password, DB_NAME: database,
    DB_POOL_QUEUE_LIMIT: "100", DB_POOL_ACQUIRE_TIMEOUT_MS: "500", LIVE_SOURCE_MODE: "path", XUI_HTTP_FALLBACK: "false",
    HLS_TEST_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` };
  const a = await startWorker(env, workers), b = await startWorker(env, workers);
  assert.notEqual(a.pid, b.pid); assert.notEqual(a.pid, process.pid);
  t.diagnostic(`Independent API PIDs: ${a.pid}, ${b.pid}`);
  const accessToken = jwt.sign({ device_id: 7, device_code: "TEST7" }, secret, { expiresIn: 3600 });
  const issue = async worker => {
    const response = await fetch(`${worker.base}/v1/playback/token`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ type: "live", stream_id: "100" }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  let issued, segmentLink, keyLink;

  await t.test("A issues JWT and master; B decrypts nested playlists, keys and segments with fresh SQL", async () => {
    issued = await issue(a);
    const response = await fetch(issued.urls.hls); assert.equal(response.status, 200);
    const master = await response.text();
    assert.equal((await b.rpc("stats")).assets, 0);
    const variant = await fetch(rehost(mediaLinks(master)[0], b.base)); assert.equal(variant.status, 200);
    const text = await variant.text();
    segmentLink = mediaLinks(text)[0]; keyLink = /URI="([^"]+)"/.exec(text)[1];
    assert.equal(new URL(segmentLink).searchParams.get("asset").split(".").length, 3);
    for (const [link, expected] of [[segmentLink, SEGMENT], [keyLink, KEY]]) {
      const asset = await fetch(rehost(link, a.base)); assert.equal(asset.status, 200);
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), expected);
    }
    for (const worker of [a, b]) assert.ok((await worker.rpc("stats")).authorizationReads > 0);
  });

  await t.test("database suspension and deletion revoke access in both independent processes", async () => {
    for (const status of ["suspended", "pending"]) {
      await db.execute("UPDATE devices SET status=? WHERE id=7", [status]);
      for (const worker of [a, b]) assert.equal((await fetch(rehost(segmentLink, worker.base))).status, 403);
    }
    await db.execute("UPDATE devices SET status='active' WHERE id=7");
    await db.execute("UPDATE device_access SET expires_at='2000-01-01' WHERE device_id=7");
    for (const worker of [a, b]) assert.equal((await fetch(rehost(segmentLink, worker.base))).status, 403);
    await db.execute("UPDATE device_access SET expires_at=DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE device_id=7");
    const temporaryToken = jwt.sign({ device_id: 8, type: "live", stream_id: 100 }, secret,
      { audience: "playback", issuer: "streamin-api", expiresIn: 3600 });
    await db.execute("DELETE FROM devices WHERE id=8");
    for (const worker of [a, b]) {
      const url = rehost(segmentLink, worker.base); url.searchParams.set("token", temporaryToken);
      assert.equal((await fetch(url)).status, 401);
    }
  });

  await t.test("concurrent segments stay within two ten-connection MariaDB pools", async () => {
    const responses = await Promise.all(Array.from({ length: 80 }, (_, i) => fetch(rehost(segmentLink, i % 2 ? a.base : b.base))));
    for (const response of responses) {
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEGMENT);
    }
    for (const worker of [a, b]) {
      const stats = await worker.rpc("stats");
      assert.ok(stats.maxCheckedOut <= 10); assert.ok(stats.connections <= 10);
      assert.equal(stats.pending, 0); assert.equal(stats.checkedOut, 0);
      t.diagnostic(`PID ${worker.pid}: ${stats.connections} connections, peak checked out ${stats.maxCheckedOut}`);
    }
  });

  await t.test("saturated pools return retryable 503 without upstream work and recover", async () => {
    const before = upstreamCalls.length;
    try {
      for (const worker of [a, b]) assert.equal(await worker.rpc("hold"), 10);
      const responses = await Promise.all(Array.from({ length: 24 }, (_, i) => fetch(rehost(segmentLink, i % 2 ? a.base : b.base))));
      for (const response of responses) {
        assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "5");
        assert.equal((await response.json()).code, "DATABASE_BUSY");
      }
      assert.equal(upstreamCalls.length, before);
    } finally { for (const worker of [a, b]) await worker.rpc("release"); }
    for (const worker of [a, b]) {
      const response = await fetch(rehost(segmentLink, worker.base)); assert.equal(response.status, 200);
      await response.arrayBuffer();
      const stats = await worker.rpc("stats"); assert.equal(stats.pending, 0); assert.equal(stats.checkedOut, 0);
    }
  });

  await t.test("legacy UUID works only on its owning cache; encrypted links survive owner loss and restart", async () => {
    // Seed the same in-memory record old Passenger versions created, then send
    // requests through the actual route. This does not simulate Passenger routing.
    const legacy = await a.rpc("legacy", { token: issued.token });
    const legacyUrl = new URL(`/v1/playback/hls-asset?token=${issued.token}&asset=${legacy}`, a.base);
    assert.equal((await fetch(legacyUrl)).status, 200);
    assert.equal((await fetch(rehost(legacyUrl, b.base))).status, 400);
    // A stable client-facing URL exercises connect-failure retry without asking
    // the player to discover another port. This is a test proxy, not Apache.
    const attempts = [];
    const proxy = http.createServer((req, res) => {
      const forward = index => {
        if (index >= 2) { res.writeHead(502); res.end(); return; }
        const worker = [a, b][index];
        attempts.push(worker.pid);
        const request = http.request(new URL(req.url, worker.base), {
          method: "GET", headers: req.headers, agent: false,
        }, response => {
          res.writeHead(response.statusCode, response.headers);
          response.on("error", () => res.destroy());
          response.pipe(res);
        });
        request.on("error", () => forward(index + 1));
        request.end();
      };
      forward(0);
    });
    proxies.push(proxy); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const proxyBase = `http://127.0.0.1:${proxy.address().port}`;
    const stableSegment = rehost(segmentLink, proxyBase), stableKey = rehost(keyLink, proxyBase);
    const before = await fetch(stableSegment); assert.equal(before.status, 200);
    assert.deepEqual(Buffer.from(await before.arrayBuffer()), SEGMENT);
    await a.stop("SIGKILL");
    await assert.rejects(fetch(rehost(segmentLink, a.base)));
    for (const [url, expected] of [[stableSegment, SEGMENT], [stableKey, KEY]]) {
      const response = await fetch(url); assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
      assert.deepEqual(attempts.slice(-2), [a.pid, b.pid]);
    }
    // A new manifest and its nested playlist also traverse the survivor through
    // the same public origin, retaining absolute playback URLs on that origin.
    const masterResponse = await fetch(`${proxyBase}/v1/playback/hls?token=${issued.token}`);
    assert.equal(masterResponse.status, 200);
    const master = await masterResponse.text();
    assert.equal(new URL(mediaLinks(master)[0]).origin, proxyBase);
    const nestedResponse = await fetch(mediaLinks(master)[0]); assert.equal(nestedResponse.status, 200);
    const nested = await nestedResponse.text();
    assert.equal(new URL(mediaLinks(nested)[0]).origin, proxyBase);
    const continued = await fetch(mediaLinks(nested)[0]); assert.equal(continued.status, 200);
    assert.deepEqual(Buffer.from(await continued.arrayBuffer()), SEGMENT);
    const restarted = await startWorker(env, workers);
    assert.notEqual(restarted.pid, a.pid);
    const response = await fetch(rehost(segmentLink, restarted.base)); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEGMENT);
    assert.equal((await fetch(rehost(legacyUrl, restarted.base))).status, 400);
  });
});
