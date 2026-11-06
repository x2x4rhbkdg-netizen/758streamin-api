const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('profile price requests deduplicate by exact service and expire; failures retry sooner', async () => {
  const text = fs.readFileSync(require.resolve('./device.routes.cjs'), 'utf8');
  const start = text.indexOf('const whmcsPriceCache');
  const end = text.indexOf('\nfunction logRegisterDebug', start);
  let now = 1000, calls = 0, fail = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = { URLSearchParams, AbortSignal, Date: { now: () => now },
    env: { WHMCS_API_URL: 'https://fixture', WHMCS_API_IDENTIFIER: 'id', WHMCS_API_SECRET: 'secret' },
    extractWhmcsPrice: row => row.price,
    fetch: async (_url, options) => {
      calls++; await gate;
      const id = Number(new URLSearchParams(options.body).get('serviceid'));
      return { ok: !fail, text: async () => JSON.stringify({ result: 'success',
        products: { product: [{ id: 999, price: 'wrong' }, { id, price: '20.00' }] } }) };
    },
  };
  vm.createContext(context); vm.runInContext(text.slice(start, end), context);
  const a = context.fetchWhmcsPriceByServiceId(10), b = context.fetchWhmcsPriceByServiceId(10);
  assert.equal(calls, 1); release();
  assert.deepEqual(await Promise.all([a, b]), ['20.00', '20.00']);
  assert.equal(await context.fetchWhmcsPriceByServiceId(10), '20.00'); assert.equal(calls, 1);
  now += 300001; fail = true;
  assert.equal(await context.fetchWhmcsPriceByServiceId(10), null); assert.equal(calls, 2);
  now += 60001; fail = false;
  assert.equal(await context.fetchWhmcsPriceByServiceId(10), '20.00'); assert.equal(calls, 3);
  assert.equal(await context.fetchWhmcsPriceByServiceId('bad'), null); assert.equal(calls, 3);
});
