const { performance } = require('node:perf_hooks');
const PAGE_SIZE = 250, MAX_PAGES = 40;
const KINDS = new Set(['http', 'timeout', 'network', 'response_too_large', 'invalid_json',
  'invalid_response', 'repeated_page', 'pagination_limit', 'cancelled']);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function rdListError(kind) {
  return Object.assign(new Error('Real-Debrid account list could not be checked'), {
    status: 502, publicMessage: 'Real-Debrid account list could not be checked', rdFailureKind: kind,
  });
}
function createRdDiagnostics({ logger = console, now = () => performance.now(), maxPerMinute = 20 } = {}) {
  let start = now(), emitted = 0, suppressed = 0;
  return { failure(error, { page, completed, startedAt, aborted }) {
    try {
      const time = now();
      if (time - start >= 60000) { start = time; emitted = 0; }
      if (emitted >= maxPerMinute) { suppressed++; return; }
      emitted++;
      const rawCode = error?.cause?.code || error?.code;
      const code = NETWORK_CODES.has(rawCode) ? rawCode : undefined;
      const http = error?.upstreamStatus;
      const category = KINDS.has(error?.rdFailureKind) ? error.rdFailureKind :
        aborted || error?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout' : 'network';
      const record = { provider: 'Real-Debrid', operation: 'account_torrents', category,
        page_size: PAGE_SIZE,
        elapsed_ms: Math.max(0, Math.round(time - startedAt)), suppressed_since_last_log: suppressed };
      if (Number.isInteger(page) && page >= 1 && page <= MAX_PAGES) record.page = page;
      if (Number.isInteger(completed) && completed >= 0 && completed <= MAX_PAGES) record.pages_completed = completed;
      if (Number.isInteger(http) && http >= 100 && http <= 599) record.http_status = http;
      if (Number.isInteger(error?.rdErrorCode) && error.rdErrorCode >= 0 && error.rdErrorCode <= 999) record.rd_error_code = error.rdErrorCode;
      if (code) record.network_code = code;
      suppressed = 0;
      logger.warn('[rd-account-check-failure]', JSON.stringify(record));
    } catch { /* Never let diagnostics affect availability or expose arbitrary error fields. */ }
  }, now };
}
const rdDiagnostics = createRdDiagnostics();

async function readRdAccountTorrents(call, { signal, diagnostics = rdDiagnostics } = {}) {
  const startedAt = diagnostics.now(), entries = [], seen = new Set();
  let page = 1, completed = 0;
  try {
    for (; page <= MAX_PAGES; page++) {
      if (signal?.aborted) throw Object.assign(rdListError('timeout'), { name: 'AbortError' });
      const rows = await call(`torrents?limit=${PAGE_SIZE}&page=${page}`);
      if (signal?.aborted) throw Object.assign(rdListError('timeout'), { name: 'AbortError' });
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw rdListError('invalid_response');
      let added = 0;
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[a-z0-9]{1,128}$/i.test(row.id) ||
          typeof row.status !== 'string' || !/^[a-z_]{1,40}$/.test(row.status)) throw rdListError('invalid_response');
        if (seen.has(row.id)) continue;
        seen.add(row.id); added++;
        if (typeof row.hash !== 'string' || !/^[a-f0-9]{40}$/i.test(row.hash)) {
          // An in-progress magnet conversion may not yet expose a usable info hash.
          if (row.status === 'downloaded') throw rdListError('invalid_response');
          continue;
        }
        // Do not retain filenames, URLs, links or other account metadata across pages.
        entries.push({ id: row.id, hash: row.hash.toLowerCase(), status: row.status });
      }
      completed++;
      if (rows.length < PAGE_SIZE) return entries;
      if (!added) throw rdListError('repeated_page');
    }
    throw rdListError('pagination_limit');
  } catch (error) {
    diagnostics.failure(error, { page: Math.min(page, MAX_PAGES), completed, startedAt, aborted: signal?.aborted === true });
    throw error;
  }
}
module.exports = { readRdAccountTorrents, createRdDiagnostics, rdListError, PAGE_SIZE, MAX_PAGES };
