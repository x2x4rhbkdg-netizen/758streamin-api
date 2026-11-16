const { performance } = require('node:perf_hooks');

const BODY_IDLE_MS = 30000;
const DOWNSTREAM_STALL_MS = 120000;

function watchMovieBody(upstream, downstream, { onTimeout, signal, idleMs = BODY_IDLE_MS,
  stallMs = DOWNSTREAM_STALL_MS, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let lastRead = now(), blockedAt = null, timer, stopped = false, reason;
  const listeners = [];
  function on(stream, event, listener) {
    stream.on(event, listener);
    listeners.push(() => stream.off(event, listener));
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimer(timer);
    for (const remove of listeners) remove();
  }
  function state(time) {
    // Readable pause alone is not sufficient: async iterators also pause between reads.
    const blocked = !downstream.writableFinished && (downstream.writableNeedDrain === true ||
      (upstream.readableEnded && downstream.writableLength > 0));
    if (blocked && blockedAt === null) blockedAt = time;
    else if (!blocked && blockedAt !== null) { blockedAt = null; lastRead = time; }
    return blocked;
  }
  function schedule() {
    if (stopped) return;
    const time = now(), blocked = state(time);
    if (upstream.readableEnded && !blocked) return stop();
    const limit = blocked ? stallMs : idleMs;
    const remaining = limit - (time - (blocked ? blockedAt : lastRead));
    if (remaining <= 0) {
      reason = blocked ? 'downstream_stall_timeout' : 'upstream_idle_timeout';
      stop();
      onTimeout(reason, limit);
      return;
    }
    clearTimer(timer);
    timer = setTimer(schedule, Math.max(1, Math.ceil(remaining)));
    timer.unref?.();
  }
  on(upstream, 'data', () => { lastRead = now(); });
  on(upstream, 'pause', schedule);
  on(upstream, 'end', schedule);
  on(downstream, 'drain', schedule);
  on(upstream, 'error', stop);
  on(upstream, 'close', () => upstream.readableEnded ? schedule() : stop());
  on(downstream, 'error', stop);
  on(downstream, 'finish', stop);
  if (signal) {
    signal.addEventListener('abort', stop, { once: true });
    listeners.push(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  }
  // Attach only immediately before the existing body consumer, never before authorization.
  schedule();
  return { stop, get reason() { return reason; } };
}

module.exports = { watchMovieBody, BODY_IDLE_MS, DOWNSTREAM_STALL_MS };
