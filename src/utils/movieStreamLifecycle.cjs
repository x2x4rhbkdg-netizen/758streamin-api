const { performance } = require('node:perf_hooks');

// Observation order is not proof of the remote cause: pipeline destruction cascades.
function createMovieStreamLifecycle({ now = () => performance.now() } = {}) {
  const started = now(), events = [], listeners = [];
  let bytes = 0, response, downstream;
  function mark(event) {
    if (events.length < 16 && !events.some(item => item.event === event)) {
      events.push({ event, elapsed_ms: Math.max(0, Math.round(now() - started)) });
    }
  }
  function on(emitter, event, callback) {
    emitter.on(event, callback);
    listeners.push(() => emitter.off(event, callback));
  }
  return {
    mark,
    request(request) {
      on(request, 'error', () => mark('request_error'));
    },
    upstream(stream) {
      response = stream;
      mark('upstream_headers');
      on(stream, 'aborted', () => mark('upstream_aborted'));
      on(stream, 'error', () => mark('upstream_error'));
      on(stream, 'end', () => mark('upstream_end'));
      on(stream, 'close', () => mark('upstream_close'));
    },
    body(stream) {
      // Only attach immediately before the existing consumer; never start flow early.
      on(stream, 'data', chunk => { bytes += Buffer.byteLength(chunk); });
    },
    downstream(stream) {
      downstream = stream;
      on(stream, 'finish', () => mark('downstream_finish'));
      on(stream, 'error', () => mark('downstream_error'));
      on(stream, 'close', () => mark(stream.writableFinished ? 'downstream_close' : 'downstream_disconnect'));
    },
    snapshot() {
      return { events: events.map(item => ({ ...item })), bytes,
        upstreamComplete: response?.complete === true,
        downstreamFinished: downstream?.writableFinished === true,
        upstreamPaused: response?.isPaused?.() === true };
    },
    dispose() { for (const remove of listeners) remove(); },
  };
}
module.exports = { createMovieStreamLifecycle };
