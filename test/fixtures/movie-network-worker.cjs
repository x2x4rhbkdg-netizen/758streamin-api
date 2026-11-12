'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const net = require('node:net');
const { publicAddress } = require('../../src/utils/scraperHttp.cjs');

// Exercise Node's actual HTTPS/TLS error propagation without sending packets.
// Native connect failures can happen synchronously (e.g. an absent IPv6 route).
// Keep this instrumentation in a child so it cannot affect the test runner.
const TCP = process.binding('tcp_wrap').TCP;
const uv = process.binding('uv');
const attempted = [];
TCP.prototype.connect6 = () => { attempted.push(6); return uv.UV_ENETUNREACH; };
TCP.prototype.connect = () => { attempted.push(4); return uv.UV_ECONNREFUSED; };
net.setDefaultAutoSelectFamily(true);
const addresses = process.argv[2] === 'ipv4-only'
  ? [{ address: '8.8.8.8', family: 4 }]
  : [{ address: '2606:4700:3036::6815:3785', family: 6 }];
if (process.argv[2] === 'dual-stack') addresses.push({ address: '8.8.8.8', family: 4 });
process.once('uncaughtException', error => {
  console.error(JSON.stringify({ uncaught: error.code }));
  process.exit(77);
});
const timer = setTimeout(() => process.exit(78), 5000);
const filename = require.resolve('../../src/routes/movieStream.routes.cjs');
const context = {
  module: { exports: {} }, URL, AbortController,
  require(name) {
    if (name === 'express') return { Router: () => ({ get() {} }) };
    if (name === 'node:dns/promises') return { lookup: async () => addresses };
    if (name === '../utils/scraperHttp.cjs') return { publicAddress };
    if (name === '../utils/pinnedLookup.cjs') return require('../../src/utils/pinnedLookup.cjs');
    if (name.startsWith('node:')) return require(name);
    return {};
  },
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = openStream;', context, { filename });
context.module.exports('https://cdn.example/movie.mp4', 'GET', {}, new AbortController().signal)
  .then(() => process.exit(79), error => {
    assert.ok(['ENETUNREACH', 'ECONNREFUSED'].includes(error.code));
    if (process.argv[2] === 'dual-stack') {
      assert.equal(attempted[0], 4);
      assert.ok(attempted.includes(4) && attempted.includes(6));
    }
    clearTimeout(timer);
    setTimeout(() => { console.log(JSON.stringify({ caught: true, attempted })); process.exit(0); }, 25);
  });
