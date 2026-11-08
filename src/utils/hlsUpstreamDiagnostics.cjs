const { performance } = require('node:perf_hooks');

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError']);

function createHlsUpstreamDiagnostics({ logger = console, now = () => performance.now(), maxPerMinute = 20 } = {}) {
  let windowStart = now(), emitted = 0, suppressed = 0;
  return {
    now,
    failure(error, { startedAt, timedOut = false, candidate, totalCandidates, timeoutMs }) {
      const time = now();
      if (time - windowStart >= 60000) { windowStart = time; emitted = 0; }
      if (emitted >= maxPerMinute) { suppressed++; return; }
      emitted++;
      const rawCode = error?.cause?.code || error?.code;
      const code = NETWORK_CODES.has(rawCode) ? rawCode : null;
      const rawStatus = Number(error?.status || 0);
      const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 0;
      let type = 'network', message = 'upstream network failure';
      if (status) { type = 'http'; message = 'upstream returned HTTP error'; }
      else if (timedOut || error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code?.endsWith('_TIMEOUT')) {
        type = 'timeout'; message = 'upstream request timed out';
      } else if (error?.name === 'AbortError') { type = 'aborted'; message = 'upstream request aborted'; }
      else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) { type = 'dns'; message = 'upstream DNS lookup failed'; }
      else if (code && /CERT|TLS|SIGNATURE/.test(code)) { type = 'tls'; message = 'upstream TLS verification failed'; }
      else if (code) { type = 'connection'; message = 'upstream connection failed'; }
      // Never log raw messages, bodies, paths or URLs: provider credentials can occur in any of them.
      const record = { failure_type: type, status: status || 'network-error',
        error: ERROR_NAMES.has(error?.name) ? error.name : 'Error', code, message,
        elapsed_ms: Math.max(0, Math.round(time - startedAt)), timeout_ms: timeoutMs > 0 ? timeoutMs : null,
        candidate, totalCandidates, suppressed_since_last_log: suppressed };
      suppressed = 0;
      try { logger.warn('[hls-upstream-failure]', record); } catch { /* Diagnostics must not change playback. */ }
    },
  };
}
module.exports = { createHlsUpstreamDiagnostics };
