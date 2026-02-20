const { env } = require("../config/env.cjs");

function toBool(v) {
  const s = String(v || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function shouldExposeDebug(req) {
  if (env.API_DEBUG_ERRORS) return true;
  if (!env.API_DEBUG_ERRORS_ALLOW_HEADER) return false;

  const debugHeader = req?.headers?.["x-debug-errors"];
  if (!toBool(debugHeader)) return false;

  const adminKey = String(req?.headers?.["x-admin-key"] || "").trim();
  if (!adminKey) return false;

  return adminKey === env.ADMIN_API_KEY;
}

function buildInternalError(req, err, extra = {}) {
  const payload = { error: extra.error || "internal error" };
  if (extra.hint) payload.hint = extra.hint;

  if (shouldExposeDebug(req)) {
    payload.code = err?.code || null;
    payload.sqlState = err?.sqlState || null;
    payload.errno = typeof err?.errno === "number" ? err.errno : null;
    payload.sqlMessage = err?.sqlMessage || err?.message || null;
    if (extra.scope) payload.scope = extra.scope;
  }

  return payload;
}

function sendInternalError(req, res, scope, err, extra = {}) {
  console.error(`[${scope}] error:`, err);
  return res.status(extra.status || 500).json(
    buildInternalError(req, err, {
      ...extra,
      scope,
    })
  );
}

module.exports = {
  shouldExposeDebug,
  buildInternalError,
  sendInternalError,
};
