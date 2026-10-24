const test = require('node:test');
const assert = require('node:assert/strict');
const { createDubIndex, parseDubIndex } = require('./myDubList.cjs');
const DAY = 86400000;
const response = (dubbed = [1, 5, 1]) => new Response(JSON.stringify({ language: 'English', dubbed }));

test('validates bounded MAL IDs and deduplicates without accepting empty or partial schemas', () => {
  assert.deepEqual(parseDubIndex({ language: 'English', dubbed: [1, 5, 1] }), [1, 5]);
  for (const value of [{}, { language: 'Japanese', dubbed: [1] }, ...[[], [0], ['1'], [1.5], [2147483648], new Array(10001).fill(1)].map(dubbed => ({ language: 'English', dubbed }))]) {
    assert.throws(() => parseDubIndex(value), { status: 503 });
  }
});
test('singleflight daily cache, refresh and bounded stale fallback with retry backoff', async () => {
  let now = 0, calls = 0, failed = false;
  const get = createDubIndex({ now: () => now, fetchImpl: async (url, options) => {
    calls++; assert.match(url, /\/confidence\/high\/dubbed_english.json$/); assert.equal(options.redirect, 'error');
    if (failed) throw new Error('offline');
    return response();
  } });
  assert.deepEqual(await Promise.all([get(), get()]), [[1, 5], [1, 5]]); assert.equal(calls, 1);
  now = DAY - 1; await get(); assert.equal(calls, 1);
  now = DAY; await get(); assert.equal(calls, 2);
  failed = true; now += DAY;
  assert.deepEqual(await get(), [1, 5]); assert.equal(calls, 3);
  await get(); assert.equal(calls, 3);
  now = 9 * DAY; await assert.rejects(get(), { status: 503 });
});
test('rejects failed, malformed and oversized downloads and backs off cold failures', async () => {
  for (const make of [() => new Response('', { status: 429 }), () => new Response('{'), () => response([]),
    () => new Response('{}', { headers: { 'content-length': '300000' } }), () => new Response(' '.repeat(262145))]) {
    let calls = 0;
    const get = createDubIndex({ fetchImpl: async () => { calls++; return make(); } });
    await assert.rejects(get(), { status: 503 });
    await assert.rejects(get(), { status: 503 }); assert.equal(calls, 1);
  }
});
