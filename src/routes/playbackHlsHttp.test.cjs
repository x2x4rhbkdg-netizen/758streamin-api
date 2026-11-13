"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const http = require("node:http");
const { createRequire } = require("node:module");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createPlaybackAssetReader, legacyAssetOrigins } = require("../utils/playbackAssetHttp.cjs");
const { createPlaybackLogging } = require('../utils/playbackLogging.cjs');
const { createHlsUpstreamDiagnostics } = require('../utils/hlsUpstreamDiagnostics.cjs');
const filename = require.resolve("./playback.routes.cjs");
const source = fs.readFileSync(filename, "utf8");
const routeRequire = createRequire(filename);
const SECRET = "758streamin-hls-http-test-secret";
const ORIGIN = "http://upstream.example";
const ROOT = "/live/test-user/test-password/100.m3u8";
const SEGMENT_PATH = "/live/test-user/test-password/segment100.ts";
const VARIANT_PATH = "/live/test-user/test-password/variants/low.m3u8";
const SEGMENT = Buffer.from([0, 255, 42, 128, 10, 13, 65, 0, 99]);
const KEY = Buffer.from("0123456789abcdef");
const MANIFEST = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6,\nsegment100.ts\n";
const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nvariants/low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160\nvariants/high.m3u8\n";
const manifestSpec = body => ({ body, type: "application/vnd.apple.mpegurl" });

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function createUpstream(t) {
  const requests = [];
  const responses = new Map([[ROOT, manifestSpec(MANIFEST)], [SEGMENT_PATH, { body: SEGMENT, type: "video/mp2t" }]]);
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    const spec = responses.get(req.url);
    if (!spec) { res.writeHead(404); res.end("missing fixture"); return; }
    if (spec.redirect) { res.writeHead(302, { Location: spec.redirect }); res.end(); return; }
    const body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body);
    const headers = { "Content-Type": spec.type || "application/octet-stream", "Accept-Ranges": "bytes" };
    if (spec.status) { res.writeHead(spec.status); res.end(body); return; }
    if (req.headers.range === "bytes=1-4") {
      const partial = body.subarray(1, 5);
      res.writeHead(206, { ...headers, "Content-Range": `bytes 1-4/${body.length}`, "Content-Length": partial.length });
      res.end(partial);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": body.length });
      res.end(body);
    }
  });
  return { base: await listen(t, server), responses, requests };
}

async function createWorker(t, upstream, platform = "web") {
  const state = { deviceStatus: "active", databaseReads: 0, assetRequests: [], internalErrors: [], logs: [] };
  const logger = { log: (tag, value) => state.logs.push({ tag, ...JSON.parse(value) }),
    warn: (tag, value) => state.logs.push({ tag, ...JSON.parse(value) }) };
  const logging = createPlaybackLogging({ logger, secret: 'fixture-logging-only' });
  // Only DNS and transport are fixtures. The production reader still validates
  // origins, redirects and addresses and processes real HTTP response streams.
  const request = (url, options, callback) => {
    state.assetRequests.push(url.href);
    return http.get(new URL(url.pathname + url.search, upstream.base), {
      headers: options.headers, signal: options.signal, agent: false,
    }, callback);
  };
  const reader = createPlaybackAssetReader({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHttp: request, requestHttps: request,
  });
  const modules = {
    '../utils/playbackLogging.cjs': { playbackLogging: logging },
    '../utils/hlsUpstreamDiagnostics.cjs': {
      createHlsUpstreamDiagnostics: () => createHlsUpstreamDiagnostics({ logger, logging }),
    },
    "../config/env.cjs": { env: { JWT_SECRET: SECRET, XUI_REQUEST_TIMEOUT_MS: 2000,
      LIVE_SOURCE_MODE: "path", LIVE_HLS_OUTPUT: "m3u8", XUI_HTTP_FALLBACK: false } },
    "../middleware/authJwt.cjs": { authJwt: (_req, _res, next) => next() },
    "../db/pool.cjs": { pool: { async execute(_sql, params) {
      state.databaseReads++;
      return [[{ status: state.deviceStatus, platform, upstream_device_id: params[0], upstream_base_url: ORIGIN }]];
    } } },
    "../utils/upstreamAuth.cjs": { resolveDeviceUpstreamRow: row => row && ({ ...row,
      username: "test-user", password: "test-password" }) },
    "../utils/playbackAssetHttp.cjs": { createPlaybackAssetReader: () => reader,
      legacyAssetOrigins: base => legacyAssetOrigins(base, "") },
    "../utils/errorResponse.cjs": { sendInternalError(_req, res, _scope, error) {
      state.internalErrors.push(error);
      return res.status(500).json({ error: "internal error" });
    } },
  };
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, AbortController, console, process, setTimeout, clearTimeout,
    module: { exports: {} },
    require: id => Object.hasOwn(modules, id) ? modules[id] : routeRequire(id),
    // Retain the logical final provider URL for relative URI rewriting while
    // serving manifests from the local fixture server, without external traffic.
    fetch: async (url, init) => {
      const target = new URL(url);
      assert.equal(target.origin, ORIGIN);
      const response = await fetch(new URL(target.pathname + target.search, upstream.base), init);
      const final = new URL(response.url);
      return { ok: response.ok, status: response.status, headers: response.headers,
        url: new URL(final.pathname + final.search, ORIGIN).href, text: () => response.text() };
    },
  });
  // Load the complete CommonJS router, including its real crypto and helpers.
  // Test-only hooks allow expired fixtures to use the same production encoder.
  vm.runInContext(source + `\nmodule.exports.testHooks = {
    encodePlaybackAssetToken, hashPlaybackToken, playbackAssetCacheById
  };`, context, { filename });
  const router = context.module.exports;
  const app = express();
  app.use("/v1", router);
  return { state, hooks: router.testHooks, base: await listen(t, http.createServer(app)) };
}

function createToken(options = {}) {
  const payload = { device_id: 7, type: "live", stream_id: 100, ...options };
  const signOptions = { audience: "playback", issuer: "streamin-api" };
  if (!Object.hasOwn(payload, "exp")) signOptions.expiresIn = 3600;
  return jwt.sign(payload, SECRET, signOptions);
}

function onWorker(link, worker) {
  const url = new URL(link, worker.base);
  return new URL(url.pathname + url.search, worker.base);
}

async function playlist(worker, token, path = "/playback/hls") {
  const response = await fetch(`${worker.base}/v1${path}?token=${encodeURIComponent(token)}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(response.headers.get("content-type"), /application\/vnd.apple.mpegurl/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return text;
}

const mediaLinks = text => text.split(/\r?\n/).filter(line => line && !line.startsWith("#"));

async function fixture(t, platform = "web") {
  const upstream = await createUpstream(t);
  const a = await createWorker(t, upstream, platform);
  const b = await createWorker(t, upstream, platform);
  return { upstream, a, b, token: createToken() };
}

test('embedded manifest failures identify stream and source without leaking credentials', async t => {
  const { upstream, a, token } = await fixture(t, 'android_tv');
  upstream.responses.set(ROOT, { status: 503, body: 'PRIVATE-PROVIDER-BODY' });
  const response = await fetch(`${a.base}/v1/playback/embedded-hls?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 503); await response.text();
  const attempt = a.state.logs.find(log => log.tag === '[hls-upstream-failure]');
  const final = a.state.logs.find(log => log.event === 'request_complete');
  assert.equal(attempt.stream_id, '100'); assert.equal(attempt.stage, 'manifest');
  assert.equal(attempt.request_id, final.request_id); assert.equal(final.outcome, 'failed');
  assert.match(attempt.source_ref, /^[a-f0-9]{24}$/);
  const encoded = JSON.stringify(a.state.logs);
  for (const secret of [token, 'test-user', 'test-password', 'upstream.example', 'PRIVATE-PROVIDER-BODY']) {
    assert.ok(!encoded.includes(secret), secret);
  }
});

test('embedded asset redirect failures identify the destination and preserve playback HTTP status', async t => {
  const { upstream, a, token } = await fixture(t, 'android_tv');
  const target = `${ORIGIN}/asset.ts`;
  upstream.responses.set('/asset.ts', { redirect: `${ORIGIN}/broken.ts` });
  upstream.responses.set('/broken.ts', { status: 503, body: 'PRIVATE-PROVIDER-BODY' });
  const response = await fetch(`${a.base}/v1/playback/embedded-hls-asset?token=${encodeURIComponent(token)}&url=${encodeURIComponent(target)}`);
  assert.equal(response.status, 503); await response.text();
  const attempt = a.state.logs.find(log => log.tag === '[hls-upstream-failure]');
  const final = a.state.logs.find(log => log.event === 'request_complete');
  assert.equal(attempt.stage, 'segment_ts'); assert.equal(final.stream_id, '100');
  assert.equal(attempt.request_id, final.request_id); assert.equal(final.failed_attempts, 1);
  assert.doesNotMatch(JSON.stringify(a.state.logs), /PRIVATE|broken\.ts|asset\.ts|upstream\.example/);
});

for (const [path, kind] of [['/encryption.key', 'key'], ['/nested.m3u8', 'manifest']]) {
  test(`embedded ${kind} failures retain request context without credential output`, async t => {
    const { upstream, a, token } = await fixture(t, 'android_tv');
    upstream.responses.set(path, { status: 503, body: 'PRIVATE-PROVIDER-BODY' });
    const response = await fetch(`${a.base}/v1/playback/embedded-hls-asset?token=${encodeURIComponent(token)}&url=${encodeURIComponent(ORIGIN + path)}`);
    assert.equal(response.status, 503); await response.text();
    const attempt = a.state.logs.find(log => log.tag === '[hls-upstream-failure]');
    const final = a.state.logs.find(log => log.event === 'request_complete');
    assert.equal(attempt.stage, kind); assert.equal(attempt.stream_id, '100');
    assert.equal(final.request_id, attempt.request_id); assert.equal(final.outcome, 'failed');
    assert.ok(!JSON.stringify(a.state.logs).includes(token));
    assert.doesNotMatch(JSON.stringify(a.state.logs), /PRIVATE|test-password|upstream\.example/);
  });
}

test("Worker A playlist assets are accessible from Worker B", async t => {
  const { upstream, a, b, token } = await fixture(t);
  const manifest = await playlist(a, token);
  assert.match(manifest, /#EXTM3U/);
  assert.ok(a.hooks.playbackAssetCacheById.size > 0);
  assert.equal(b.hooks.playbackAssetCacheById.size, 0);
  const response = await fetch(onWorker(mediaLinks(manifest)[0], b));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEGMENT);
  assert.equal(b.state.assetRequests.length, 1);
  assert.equal(b.state.databaseReads, 1);
  assert.equal(upstream.requests.length, 2);
});

test("Suspended device cannot retrieve HLS segments", async t => {
  const { upstream, a, b, token } = await fixture(t);
  const manifest = await playlist(a, token);
  b.state.deviceStatus = "suspended";
  const count = upstream.requests.length;
  const response = await fetch(onWorker(mediaLinks(manifest)[0], b));
  assert.equal(response.status, 403);
  assert.equal(upstream.requests.length, count);
  assert.equal(b.state.assetRequests.length, 0);
});

test("Expired playback token is rejected", async t => {
  const { a } = await fixture(t);
  const token = createToken({ exp: Math.floor(Date.now() / 1000) - 10 });
  const response = await fetch(`${a.base}/v1/playback/hls?token=${token}`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "PLAYBACK_TOKEN_EXPIRED");
  assert.equal(a.state.databaseReads, 0);
});

test("Tampered encrypted asset IDs are rejected before upstream access", async t => {
  const { a, b, token } = await fixture(t);
  const manifest = await playlist(a, token);
  const url = onWorker(mediaLinks(manifest)[0], b);
  const original = url.searchParams.get("asset");
  const invalid = ["not-an-asset", "a.b.c", "@@@.aaa.bbb", ".a.b", "a".repeat(32769)];
  for (const index of [0, 1, 2]) {
    const parts = original.split(".");
    const bytes = Buffer.from(parts[index], "base64url");
    bytes[0] ^= 1;
    parts[index] = bytes.toString("base64url");
    invalid.push(parts.join("."));
  }
  for (const asset of invalid) {
    url.searchParams.set("asset", asset);
    const response = await fetch(url);
    // Node's HTTP parser rejects overlong request targets before Express.
    assert.equal(response.status, asset.length > 32768 ? 431 : 400);
    if (response.status === 400) {
      assert.deepEqual(await response.json(), { error: "invalid playback asset token" });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  assert.equal(b.state.internalErrors.length, 0);
  assert.equal(b.state.assetRequests.length, 0);
});

for (const [name, expiry] of [["expired", Date.now() - 10000], ["missing", undefined], ["zero", 0], ["invalid", "not-a-date"]]) {
  test(`Encrypted asset expiry is rejected when ${name}`, async t => {
    const { a, b, token } = await fixture(t);
    const asset = a.hooks.encodePlaybackAssetToken({ h: a.hooks.hashPlaybackToken(token), u: `${ORIGIN}/segment.ts`, e: expiry });
    const response = await fetch(`${b.base}/v1/playback/hls-asset?token=${token}&asset=${asset}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "playback asset expired");
    assert.equal(b.state.assetRequests.length, 0);
  });
}

test("Another device or session cannot use the issuing token's assets", async t => {
  const { a, b, token } = await fixture(t);
  const manifest = await playlist(a, token);
  for (const other of [createToken({ device_id: 8 }), createToken({ live_session: "other-session" })]) {
    for (const worker of [a, b]) {
      const url = onWorker(mediaLinks(manifest)[0], worker);
      url.searchParams.set("token", other);
      const response = await fetch(url);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "playback asset not found");
      assert.equal(worker.state.assetRequests.length, 0);
    }
  }
});

test("Master and nested variant playlists rewrite segments across workers", async t => {
  const { upstream, a, b, token } = await fixture(t);
  upstream.responses.set(ROOT, manifestSpec(MASTER));
  upstream.responses.set(VARIANT_PATH, manifestSpec("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nnested.m3u8"));
  upstream.responses.set("/live/test-user/test-password/variants/nested.m3u8", manifestSpec("#EXTM3U\n#EXTINF:6,\n../segment100.ts"));
  let text = await playlist(a, token);
  assert.equal(mediaLinks(text).length, 2);
  for (const worker of [b, a]) {
    const url = onWorker(mediaLinks(text)[0], worker);
    assert.equal(url.pathname, "/v1/playback/hls-asset");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /mpegurl/);
    text = await response.text();
    assert.ok(mediaLinks(text).every(link => new URL(link).pathname === "/v1/playback/hls-asset"));
  }
  const response = await fetch(onWorker(mediaLinks(text)[0], b));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEGMENT);
  assert.ok(b.state.assetRequests.includes(`${ORIGIN}${SEGMENT_PATH}`));
});

test("HLS encryption keys and initialization maps are protected across workers", async t => {
  const { upstream, a, b, token } = await fixture(t);
  upstream.responses.set(ROOT, manifestSpec('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/channel.key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment100.ts'));
  upstream.responses.set("/live/test-user/test-password/keys/channel.key", { body: KEY });
  upstream.responses.set("/live/test-user/test-password/init.mp4", { body: SEGMENT, type: "video/mp4" });
  const manifest = await playlist(a, token);
  const uris = [...manifest.matchAll(/URI="([^"]+)"/g)].map(match => match[1]);
  assert.equal(uris.length, 2);
  for (const [index, link] of uris.entries()) {
    const url = onWorker(link, b);
    assert.equal(url.pathname, "/v1/playback/hls-asset");
    assert.equal(url.searchParams.get("token"), token);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), index === 0 ? KEY : SEGMENT);
    url.searchParams.set("token", createToken({ device_id: 8 }));
    assert.equal((await fetch(url)).status, 404);
  }
});

test("HTTP ranges preserve 206, Content-Range and exact binary bytes", async t => {
  const { upstream, a, b, token } = await fixture(t);
  const manifest = await playlist(a, token);
  const response = await fetch(onWorker(mediaLinks(manifest)[0], b), { headers: { Range: "bytes=1-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 1-4/${SEGMENT.length}`);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("content-type"), "video/mp2t");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEGMENT.subarray(1, 5));
  assert.equal(upstream.requests.at(-1).headers.range, "bytes=1-4");
});

for (const platform of ["android_tv", "samsung", "samsung_tizen_web"]) {
  test(`${platform} embedded HLS selects a stable variant and supports its asset route`, async t => {
    const { upstream, a, b, token } = await fixture(t, platform);
    upstream.responses.set(ROOT, manifestSpec(MASTER));
    upstream.responses.set(VARIANT_PATH, manifestSpec("#EXTM3U\n#EXTINF:6,\n../segment100.ts"));
    const manifest = await playlist(a, token, "/playback/embedded-hls");
    // Legacy embedded manifests intentionally return absolute upstream links.
    assert.deepEqual(mediaLinks(manifest), [`${ORIGIN}${SEGMENT_PATH}`]);
    assert.ok(!upstream.requests.some(req => req.path.endsWith("high.m3u8")));
    const asset = `${b.base}/v1/playback/embedded-hls-asset?token=${token}&url=${encodeURIComponent(mediaLinks(manifest)[0])}`;
    const response = await fetch(asset);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), SEGMENT);
    b.state.deviceStatus = "suspended";
    assert.equal((await fetch(asset)).status, 403);
    const protectedManifest = await playlist(a, token);
    const segment = await fetch(onWorker(mediaLinks(protectedManifest)[0], a));
    assert.equal(segment.status, 200);
    assert.deepEqual(Buffer.from(await segment.arrayBuffer()), SEGMENT);
  });
}

test("Embedded assets reject unapproved origins, redirects, private hosts and unsupported clients", async t => {
  const { upstream, b, token } = await fixture(t, "android_tv");
  const asset = url => `${b.base}/v1/playback/embedded-hls-asset?token=${token}&url=${encodeURIComponent(url)}`;
  for (const url of ["http://unapproved.example/a.ts", "http://127.0.0.1/a.ts", "file:///a.ts"]) {
    assert.equal((await fetch(asset(url))).status, url.startsWith("file:") ? 400 : 403);
  }
  assert.equal(b.state.assetRequests.length, 0);
  upstream.responses.set("/redirect.ts", { redirect: "http://unapproved.example/a.ts" });
  assert.equal((await fetch(asset(`${ORIGIN}/redirect.ts`))).status, 403);
  assert.deepEqual(b.state.assetRequests, [`${ORIGIN}/redirect.ts`]);
  const web = await createWorker(t, upstream, "web");
  assert.equal((await fetch(`${web.base}/v1/playback/embedded-hls?token=${token}`)).status, 404);
  assert.equal((await fetch(`${web.base}/v1/playback/embedded-hls-asset?token=${token}&url=${encodeURIComponent(`${ORIGIN}/a.ts`)}`)).status, 404);
});
