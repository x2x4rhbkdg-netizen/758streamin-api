const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchMovieBody, BODY_IDLE_MS, DOWNSTREAM_STALL_MS } = require('./movieBodyTimeout.cjs');

function fixture() {
  let time = 0, next = 0;
  const timers = new Map(), fired = [], controller = new AbortController();
  const upstream = Object.assign(new EventEmitter(), { readableEnded: false });
  const downstream = Object.assign(new EventEmitter(), { writableNeedDrain: false, writableFinished: false, writableLength: 0 });
  const guard = watchMovieBody(upstream, downstream, { now: () => time, signal: controller.signal,
    onTimeout: (reason, limit) => fired.push({ reason, limit, time }),
    setTimer(fn, ms) { const id = ++next; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimer: id => timers.delete(id) });
  function advance(ms) {
    const target = time + ms;
    for (;;) {
      const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > target) break;
      time = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    time = target;
  }
  return { upstream, downstream, guard, fired, timers, advance, controller,
    block() { downstream.writableNeedDrain = true; downstream.writableLength = 65536; upstream.emit('pause'); },
    drain() { downstream.writableNeedDrain = false; downstream.writableLength = 0; downstream.emit('drain'); } };
}

test('movie timeout defaults retain 30-second source idle and bound client drain at 120 seconds', () => {
  assert.equal(BODY_IDLE_MS, 30000); assert.equal(DOWNSTREAM_STALL_MS, 120000);
});
test('source inactivity times out at the body idle limit and removes all listeners/timers', () => {
  const f = fixture();
  f.advance(29999); assert.equal(f.fired.length, 0);
  f.advance(1); assert.deepEqual(f.fired, [{ reason: 'upstream_idle_timeout', limit: 30000, time: 30000 }]);
  assert.equal(f.guard.reason, 'upstream_idle_timeout');
  assert.equal(f.timers.size, 0);
  assert.equal(f.upstream.eventNames().length, 0); assert.equal(f.downstream.eventNames().length, 0);
  f.advance(120000); assert.equal(f.fired.length, 1);
});
test('body progress resets source idle accounting without imposing a total transfer deadline', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { f.advance(10000); f.upstream.emit('data', Buffer.alloc(1)); }
  assert.equal(f.fired.length, 0);
  f.advance(29999); assert.equal(f.fired.length, 0);
  f.advance(1); assert.equal(f.fired[0].time, 130000);
});
test('backpressure suspends the source idle limit but never extends the continuous drain deadline', () => {
  const f = fixture(); f.advance(10000); f.block();
  f.advance(60000); assert.equal(f.fired.length, 0);
  f.upstream.emit('data', Buffer.alloc(1)); f.upstream.emit('pause');
  f.advance(59999); assert.equal(f.fired.length, 0);
  f.advance(1); assert.deepEqual(f.fired, [{ reason: 'downstream_stall_timeout', limit: 120000, time: 130000 }]);
});
test('draining grants a fresh idle window and a subsequent stall is still bounded', () => {
  const f = fixture(); f.advance(25000); f.block(); f.advance(60000); f.drain();
  f.advance(29999); assert.equal(f.fired.length, 0);
  f.advance(1); assert.equal(f.fired[0].reason, 'upstream_idle_timeout');
  assert.equal(f.fired[0].time, 115000);
});
test('repeated drain cycles reset their own budget rather than imposing a total backpressure duration', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) { f.block(); f.advance(100000); f.drain(); f.upstream.emit('data', Buffer.alloc(1)); }
  assert.equal(f.fired.length, 0); f.guard.stop(); assert.equal(f.timers.size, 0);
});
test('readable pause without downstream pressure (including manifest iteration) does not disable idle enforcement', () => {
  const f = fixture(); f.upstream.emit('pause'); f.advance(30000);
  assert.equal(f.fired[0].reason, 'upstream_idle_timeout');
});
test('normal source close does not remove protection for a final undrained downstream write', () => {
  const f = fixture(); f.block(); f.upstream.readableEnded = true;
  f.upstream.emit('end'); f.upstream.emit('close'); f.advance(120000);
  assert.equal(f.fired[0].reason, 'downstream_stall_timeout');
});
test('a final buffered write is bounded even when writableNeedDrain is false', () => {
  const f = fixture(); f.upstream.readableEnded = true; f.downstream.writableLength = 100;
  f.upstream.emit('end'); f.upstream.emit('close'); f.advance(120000);
  assert.equal(f.fired[0].reason, 'downstream_stall_timeout');
});
test('completed source followed by drain or downstream finish cleans up without a later timeout', () => {
  for (const event of ['drain', 'finish']) {
    const f = fixture(); f.block(); f.upstream.readableEnded = true; f.upstream.emit('end');
    if (event === 'drain') f.drain();
    else { f.downstream.writableFinished = true; f.downstream.emit('finish'); }
    f.advance(150000); assert.equal(f.fired.length, 0); assert.equal(f.timers.size, 0);
  }
});
test('abort, source truncation, errors and explicit cleanup remove timers and owned listeners', () => {
  for (const finish of [f => f.controller.abort(), f => f.upstream.emit('close'),
    f => f.upstream.emit('error', new Error('PRIVATE')), f => f.downstream.emit('error', new Error('PRIVATE')),
    f => f.guard.stop()]) {
    const f = fixture(); finish(f); f.guard.stop(); f.advance(150000);
    assert.equal(f.fired.length, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.upstream.eventNames().length, 0); assert.equal(f.downstream.eventNames().length, 0);
  }
});
