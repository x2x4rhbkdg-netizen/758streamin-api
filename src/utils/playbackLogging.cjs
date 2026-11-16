const { AsyncLocalStorage } = require('node:async_hooks');
const { createHmac, createHash, randomBytes, randomUUID } = require('node:crypto');

function createPlaybackLogging({ logger = console, secret = process.env.PLAYBACK_LOG_SECRET || randomBytes(32), now = Date.now } = {}) {
  const storage = new AsyncLocalStorage();
  const budgets = Object.fromEntries(['routine', 'failure', 'resolve_routine', 'resolve_failure']
    .map(name => [name, { start: now(), emitted: 0, suppressed: 0 }]));
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
      const kind = fields.failed_attempts || fields.status >= 400 || fields.outcome === 'aborted' ? 'failure' : 'routine';
      const budget = budgets[(fields.route === '/adult/resolve' ? 'resolve_' : '') + kind];
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
    return { request_id, route, stream_id, media_type, platform, session_ref, stage, source_kind: state.source_kind, ...state.destination };
  }
  function identify(payload, device, token) {
    const state = storage.getStore();
    if (!state) return;
    const id = String(payload.stream_id || payload.episode_id || '');
    state.stream_id = /^\d{1,20}$/.test(id) ? id : undefined;
    state.media_type = ['live', 'vod', 'series', 'adult', 'anime'].includes(payload.type) ? payload.type : 'unknown';
    state.platform = ['android_tv', 'samsung', 'samsung_tv', 'samsung_tizen_web', 'tizen', 'android', 'ios', 'web'].includes(device.platform) ? device.platform : 'other';
    if (token != null) {
      const fingerprint = createHash('sha256').update(String(token).trim()).digest().subarray(0, 16).toString('base64url');
      state.session_ref = ref('session', fingerprint);
    }
  }
  function stage(value) { const state = storage.getStore(); if (state) state.stage = value; }
  function target(url) { const state = storage.getStore(); if (state) state.destination = source(url); }
  function resolveSource(kind) {
    const state = storage.getStore();
    if (state?.route === '/adult/resolve' && ['direct', 'provider'].includes(kind)) state.source_kind = kind;
  }
  function failure(url) {
    const state = storage.getStore();
    const destination = url ? source(url) : state?.destination || {};
    if (state) { state.failures++; state.last_failed_source_ref = destination.source_ref; }
    return { ...context(), ...destination };
  }
  function middleware(req, res, next) {
    // Never retain a protected ticket from the dynamic movie-stream path.
    const path = String(req.path || '').replace(/\/$/, '');
    const route = /^\/movies\/stream\/[^/]+$/.test(path) ? '/movies/stream/:ticket' : path;
    if (!['/movies/stream/:ticket', '/adult/resolve'].includes(route) && !/^\/playback\/(?:hls|hls-asset|embedded-hls|embedded-hls-asset|stream)$/.test(route)) return next();
    // Several mounted routers can observe the same request; retain one context/outcome.
    if (storage.getStore()?.route === route) return next();
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
      if (route === '/adult/resolve') debug('adult_resolve_started');
      next();
    });
  }
  function debug(event, details = {}) {
    // Do not forward arbitrary strings, URLs, headers, messages or customer identifiers.
    if (!/^(?:adult_resolve_(?:started|result)|stream_lifecycle|stream_response|playback_token_(?:issued|cached)|hls_(?:request|manifest_ok|manifest_error|asset_request|asset_manifest_ok|asset_ok|asset_error)|direct_source_skipped|live_lookup_failed|variant_failed)$/.test(event)) return;
    if (event === 'hls_asset_ok' || event === 'hls_asset_request') return;
    const fields = { ...context() };
    if (event.startsWith('adult_resolve_') && fields.route !== '/adult/resolve') return;
    const stream = String(details.streamId || '');
    if (/^\d{1,20}$/.test(stream)) fields.stream_id = stream;
    if (!fields.session_ref && details.token) fields.session_ref = ref('session', String(details.token));
    if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) fields.status = details.status;
    if (event === 'stream_lifecycle') {
      if (fields.route !== '/movies/stream/:ticket') return;
      const allowed = new Set(['upstream_headers', 'upstream_aborted', 'upstream_error', 'upstream_end', 'upstream_close',
        'request_error', 'socket_timeout', 'headers_deadline', 'downstream_finish', 'downstream_error',
        'downstream_close', 'downstream_disconnect', 'proxy_cleanup', 'upstream_idle_timeout', 'downstream_stall_timeout']);
      fields.events = (Array.isArray(details.events) ? details.events : []).slice(0, 16)
        .filter(item => allowed.has(item?.event) && Number.isSafeInteger(item.elapsed_ms) && item.elapsed_ms >= 0)
        .map(item => ({ event: item.event, elapsed_ms: item.elapsed_ms }));
      if (Number.isSafeInteger(details.bytes) && details.bytes >= 0) fields.upstream_bytes_consumed = details.bytes;
      fields.upstream_complete = details.upstreamComplete === true;
      fields.downstream_finished = details.downstreamFinished === true;
      fields.upstream_paused_at_snapshot = details.upstreamPaused === true;
      fields.outcome = fields.downstream_finished ? 'ok' : 'aborted';
    }
    if (event === 'stream_response') {
      if (['hls', 'video', 'audio', 'html', 'json', 'binary', 'other'].includes(details.responseKind)) fields.response_kind = details.responseKind;
      if (typeof details.rangeRequested === 'boolean') fields.range_requested = details.rangeRequested;
      if (typeof details.headersApplied === 'boolean') fields.addon_headers_applied = details.headersApplied;
      if (Number.isInteger(details.redirects) && details.redirects >= 0 && details.redirects <= 3) fields.redirect_count = details.redirects;
    }
    if (event === 'adult_resolve_result' && fields.route === '/adult/resolve' && details.protectedLinkIssued === true) {
      fields.protected_link_issued = true;
      fields.playback_route = '/v1/movies/stream/:ticket';
      if (['hls', 'file', 'unknown'].includes(details.playbackFormat)) fields.playback_format = details.playbackFormat;
    }
    emit(event, fields);
  }
  return { middleware, identify, stage, target, resolveSource, failure, context, source, debug };
}

const playbackLogging = createPlaybackLogging();
module.exports = { createPlaybackLogging, playbackLogging };
