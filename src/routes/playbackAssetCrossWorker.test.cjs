'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(
  require.resolve('./playback.routes.cjs'),
  'utf8'
);

const SECRET = '758-streamin-cross-worker-test-secret';

function createWorker(secret = SECRET) {
  const context = vm.createContext({
    Buffer,
    Date,
    JSON,
    String,
    Number,
    Math,
    Error,

    createHash: crypto.createHash,
    createCipheriv: crypto.createCipheriv,
    createDecipheriv: crypto.createDecipheriv,
    randomBytes: crypto.randomBytes,

    env: {
      JWT_SECRET: secret
    },

    playbackAssetCacheById: new Map(),
    playbackAssetCacheByRequestKey: new Map(),
    PLAYBACK_ASSET_CACHE_MAX: 1000
  });

  // Extract the production encryption-key derivation.
  const keyStart = source.indexOf(
    'const playbackAssetCryptoKey ='
  );

  const keyEnd = source.indexOf(
    '\nconst EMBEDDED_HLS_MAX_DEPTH',
    keyStart
  );

  assert.ok(keyStart >= 0);
  assert.ok(keyEnd > keyStart);

  vm.runInContext(
    source.slice(keyStart, keyEnd),
    context
  );

  // Load the actual production crypto helpers.
  const helpersStart = source.indexOf(
    'function encodeBase64Url('
  );

  const helpersEnd = source.indexOf(
    '\nfunction summarizeUrlForLog(',
    helpersStart
  );

  assert.ok(helpersStart >= 0);
  assert.ok(helpersEnd > helpersStart);

  vm.runInContext(
    source.slice(helpersStart, helpersEnd),
    context
  );

  return context;
}

test(
  'HLS encrypted assets survive independent Node workers',
  () => {
    const workerA = createWorker();
    const workerB = createWorker();

    const playbackToken = 'signed-playback-token';
    const targetUrl = 'https://cdn.example/live/segment.ts';
    const expiresAt = Date.now() + 60000;

    // Worker A generates the encrypted asset.
    const assetId = workerA.encodePlaybackAssetToken({
      h: workerA.hashPlaybackToken(playbackToken),
      u: targetUrl,
      e: expiresAt
    });

    assert.ok(assetId);
    assert.equal(assetId.split('.').length, 3);

    // Worker B has no shared cache.
    assert.equal(
      workerB.playbackAssetCacheById.size,
      0
    );

    // Worker B independently decrypts the asset.
    const decoded = workerB.decodePlaybackAssetToken(
      assetId
    );

    assert.equal(decoded.u, targetUrl);
    assert.equal(decoded.e, expiresAt);

    assert.equal(
      decoded.h,
      workerB.hashPlaybackToken(playbackToken)
    );
  }
);

test(
  'HLS encrypted assets reject tampering',
  () => {
    const worker = createWorker();

    const assetId = worker.encodePlaybackAssetToken({
      h: worker.hashPlaybackToken('token'),
      u: 'https://cdn.example/segment.ts',
      e: Date.now() + 60000
    });

    const parts = assetId.split('.');

    // Modify the authentication tag.
    const tag = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    );

    tag[0] ^= 1;

    parts[1] = tag.toString('base64url');

    assert.throws(() => {
      worker.decodePlaybackAssetToken(
        parts.join('.')
      );
    });
  }
);

test(
  'HLS assets cannot be decrypted with another worker secret',
  () => {
    const workerA = createWorker('secret-A');
    const workerB = createWorker('secret-B');

    const assetId = workerA.encodePlaybackAssetToken({
      h: workerA.hashPlaybackToken('token'),
      u: 'https://cdn.example/segment.ts',
      e: Date.now() + 60000
    });

    assert.throws(() => {
      workerB.decodePlaybackAssetToken(assetId);
    });
  }
);

test(
  'HLS asset hash remains bound to its issuing playback token',
  () => {
    const workerA = createWorker();
    const workerB = createWorker();

    const originalToken = 'device-A-playback-token';
    const otherToken = 'device-B-playback-token';

    const assetId = workerA.encodePlaybackAssetToken({
      h: workerA.hashPlaybackToken(originalToken),
      u: 'https://cdn.example/segment.ts',
      e: Date.now() + 60000
    });

    const decoded = workerB.decodePlaybackAssetToken(assetId);

    assert.equal(
      decoded.h,
      workerB.hashPlaybackToken(originalToken)
    );

    assert.notEqual(
      decoded.h,
      workerB.hashPlaybackToken(otherToken)
    );
  }
);