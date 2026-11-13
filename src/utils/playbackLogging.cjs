const { AsyncLocalStorage } = require('node:async_hooks');
const { createHmac, createHash, randomBytes, randomUUID } = require('node:crypto');

function createPlaybackLogging({ logger = console, secret = process.env.PLAYBACK_LOG_SECRET || randomBytes(32), now = Date.now } = {}) {
  const storage = new AsyncLocalStorage();
  const budgets = { routine: { start: now(), emitted: 0, suppressed: 0 }, failure: { start: now(), emitted: 0, suppressed: 0 } };
  const ref = (kind, value) => createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex').slice(0, 24);
  function source(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return {};
      return { source_ref: ref('origin', url.origin), transport: url.protocol.slice(0, -1) };
    } catch { return {}; }
  }
  function emit(event, fields) {
    try {
      const budget = budgets[fields.failed_attempts || fields.status >= 400 || fields.outcome === 'aborted' ? 'failure' : 'routine'];
      if (now() - budget.start >= 60000) { budget.start = now(); budget.emitted = 0; }
      if (budget.emitted >= 60) { budget.suppressed++; return; }
      budget.emitted++;
      logger.log('[playback]', JSON.stringify({ event, ...fields, suppressed_since_last_log: budget.suppressed }));
      budget.suppressed = 0;
    } catch { /* Logging must never interrupt playback. */ }
  }
  function context() {
    const state = storage.getStore();
    if (!state) return {};
    const { request_id, route, stream_id, media_type, platform, session_ref, stage } = state;
    return { request_id, route, stream_id, media_type, platform, session_ref, stage, ...state.destination };
  }
  function identify(payload, device, token) {
    const state = storage.getStore();
    if (!state) return;
    const id = String(payload.stream_id || payload.episode_id || '');
    state.stream_id = /^\d{1,20}$/.test(id) ? id : undefined;
    state.media_type = ['live', 'vod', 'series'].includes(payload.type) ? payload.type : 'unknown';
    state.platform = ['android_tv', 'samsung', 'samsung_tv', 'samsung_tizen_web', 'tizen', 'android', 'ios', 'web'].includes(device.platform) ? device.platform : 'other';
    const fingerprint = createHash('sha256').update(String(token).trim()).digest().subarray(0, 16).toString('base64url');
    state.session_ref = ref('session', fingerprint);
  }
  function stage(value) { const state = storage.getStore(); if (state) state.stage = value; }
  function target(url) { const state = storage.getStore(); if (state) state.destination = source(url); }
  function failure(url) {
    const state = storage.getStore();
    if (state) { state.failures++; state.last_failed_source_ref = source(url).source_ref; }
    return { ...context(), ...source(url) };
  }
  function middleware(req, res, next) {
    const route = String(req.path || '');
    if (!/^\/playback\/(?:hls|hls-asset|embedded-hls|embedded-hls-asset|stream)$/.test(route)) return next();
    const started = now();
    const state = { request_id: randomUUID(), route, stage: 'authorization', failures: 0 };
    storage.run(state, () => {
      let finished = false;
      const complete = aborted => {
        if (finished) return;
        finished = true;
        // Successful segments are deliberately quiet; playlists and failures retain outcomes.
        if (!aborted && res.statusCode < 400 && !state.failures && route.endsWith('-asset')) return;
        emit('request_complete', { ...context(), last_failed_source_ref: state.last_failed_source_ref,
          status: res.statusCode, outcome: aborted ? 'aborted' : res.statusCode >= 400 ? 'failed' : state.failures ? 'recovered' : 'ok',
          failed_attempts: state.failures, elapsed_ms: Math.max(0, now() - started) });
      };
      res.once('finish', () => storage.run(state, () => complete(false)));
      res.once('close', () => storage.run(state, () => complete(!res.writableFinished)));
      next();
    });
  }
  function debug(event, details = {}) {
    // Do not forward arbitrary strings, URLs, headers, messages or customer identifiers.
    if (!/^(?:playback_token_(?:issued|cached)|hls_(?:request|manifest_ok|manifest_error|asset_request|asset_manifest_ok|asset_ok|asset_error)|direct_source_skipped|live_lookup_failed|variant_failed)$/.test(event)) return;
    if (event === 'hls_asset_ok' || event === 'hls_asset_request') return;
    const fields = { ...context() };
    const stream = String(details.streamId || '');
    if (/^\d{1,20}$/.test(stream)) fields.stream_id = stream;
    if (!fields.session_ref && details.token) fields.session_ref = ref('session', String(details.token));
    if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) fields.status = details.status;
    emit(event, fields);
  }
  return { middleware, identify, stage, target, failure, context, source, debug };
}

const playbackLogging = createPlaybackLogging();
module.exports = { createPlaybackLogging, playbackLogging };
