const test = require('node:test');
const assert = require('node:assert/strict');
const { createPinnedLookup } = require('./pinnedLookup.cjs');
const ipv6 = { address: '2606:4700:4700::1111', family: 6 };
const ipv4 = { address: '8.8.8.8', family: 4 };
const lookup = (fn, options) => new Promise((resolve, reject) => fn('cdn.example', options,
  (error, address, family) => error ? reject(error) : resolve({ address, family })));

test('pinned lookup defers callbacks until socket error handlers can attach', async () => {
  const fn = createPinnedLookup([ipv6]);
  let called = false;
  const result = new Promise(resolve => fn('cdn.example', { all: true }, (error, value) => {
    called = true; assert.equal(error, null); assert.deepEqual(value, [ipv6]); resolve();
  }));
  assert.equal(called, false);
  await result; assert.equal(called, true);
});

test('prefers IPv4 but retains every checked IPv4 and IPv6 address for fallback', async () => {
  const second = { address: '1.1.1.1', family: 4 };
  const fn = createPinnedLookup([ipv6, ipv4, second]);
  assert.deepEqual((await lookup(fn, { all: true })).address, [ipv4, second, ipv6]);
  assert.deepEqual(await lookup(fn, {}), { address: ipv4.address, family: 4 });
});

test('honors explicit family requests without resolving another DNS address', async () => {
  const fn = createPinnedLookup([ipv6, ipv4]);
  assert.deepEqual(await lookup(fn, { family: 6 }), { address: ipv6.address, family: 6 });
  assert.deepEqual((await lookup(fn, { family: 4, all: true })).address, [ipv4]);
  assert.deepEqual(await lookup(fn, 6), { address: ipv6.address, family: 6 });
});

test('unavailable families return a deferred DNS error rather than unvalidated fallback', async () => {
  await assert.rejects(lookup(createPinnedLookup([ipv6]), { family: 4 }), { code: 'ENOTFOUND' });
  await assert.rejects(lookup(createPinnedLookup([]), {}), { code: 'ENOTFOUND' });
});

test('the pinned snapshot cannot be changed through input or returned answer mutations', async () => {
  const source = [{ ...ipv6 }, { ...ipv4 }], fn = createPinnedLookup(source);
  source[0].address = '127.0.0.1'; source.push({ address: '10.0.0.1', family: 4 });
  const first = await lookup(fn, { all: true }); first.address[0].address = '192.168.1.1';
  assert.deepEqual((await lookup(fn, { all: true })).address, [ipv4, ipv6]);
});
