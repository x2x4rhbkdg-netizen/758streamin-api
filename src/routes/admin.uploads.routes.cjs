const { Router } = require("express");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { adminAuth } = require("../middleware/adminAuth.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

const VALID_SLOT_KEYS = new Set(["home_left", "home_right"]);
const VALID_KINDS = new Set(["poster", "media"]);

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
};

const POSTER_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MEDIA_MIMES = new Set([...POSTER_MIMES, "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);

const MAX_POSTER_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function requireSuperAdmin(req, res) {
  if (!req.admin || req.admin.role !== "super_admin") {
    res.status(403).json({ error: "super admin required" });
    return false;
  }
  return true;
}

function normStr(v, max = 255) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function getHomeAdsUploadDir() {
  const configured = normStr(process.env.HOME_AD_UPLOAD_DIR, 2000);
  if (configured) return configured;
  return path.join(__dirname, "..", "..", "tmp", "uploads", "home-ads");
}

function getPublicBase(req) {
  const configured = normStr(process.env.HOME_AD_UPLOAD_PUBLIC_BASE_URL, 2000).replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (!host) return "/uploads/home-ads";
  return `${proto}://${host}/uploads/home-ads`;
}

function parseDataUrl(input) {
  const s = String(input || "").trim();
  const m = s.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  const mime = String(m[1] || "").toLowerCase();
  const b64 = String(m[2] || "").replace(/\s+/g, "");
  try {
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) return null;
    return { mime, bytes };
  } catch {
    return null;
  }
}

function sanitizeFileStem(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return (base || "asset").slice(0, 64);
}

async function storeHomeAdUpload(req, res, { slotKey, kind, fileName, mime, bytes }) {
  if (!VALID_SLOT_KEYS.has(slotKey)) return res.status(400).json({ error: "invalid slot_key" });
  if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: "invalid kind" });
  if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: "empty file" });

  const allowed = kind === "poster" ? POSTER_MIMES : MEDIA_MIMES;
  const maxBytes = kind === "poster" ? MAX_POSTER_BYTES : MAX_MEDIA_BYTES;

  if (!allowed.has(mime)) {
    return res.status(400).json({ error: `unsupported file type: ${mime}` });
  }
  if (bytes.length > maxBytes) {
    return res.status(400).json({ error: `file too large (max ${Math.floor(maxBytes / (1024 * 1024))}MB)` });
  }

  const ext = MIME_EXT[mime] || "bin";
  const stem = sanitizeFileStem(fileName);
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  const finalName = `${slotKey}-${kind}-${stem}-${stamp}-${rand}.${ext}`;

  const rootDir = getHomeAdsUploadDir();
  const slotDir = path.join(rootDir, slotKey);
  await fs.promises.mkdir(slotDir, { recursive: true });

  const filePath = path.join(slotDir, finalName);
  await fs.promises.writeFile(filePath, bytes);

  const publicBase = getPublicBase(req);
  const url = `${publicBase.replace(/\/+$/, "")}/${slotKey}/${encodeURIComponent(finalName)}`;

  return res.json({
    ok: true,
    slot_key: slotKey,
    kind,
    mime_type: mime,
    size_bytes: bytes.length,
    url,
  });
}

router.post(
  "/uploads/home-ads-binary",
  adminAuth,
  express.raw({ type: () => true, limit: "30mb" }),
  async (req, res) => {
    try {
      if (!requireSuperAdmin(req, res)) return;

      const slotKey = normStr(req.headers["x-upload-slot-key"], 32).toLowerCase();
      const kind = normStr(req.headers["x-upload-kind"], 32).toLowerCase();
      const fileName = decodeURIComponent(normStr(req.headers["x-upload-file-name"], 255) || "asset");
      const mime = normStr(req.headers["content-type"], 120).toLowerCase();
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

      return await storeHomeAdUpload(req, res, { slotKey, kind, fileName, mime, bytes });
    } catch (err) {
      const code = String(err?.code || "");
      const pathValue = String(err?.path || "");
      let hint = undefined;
      if (code === "EACCES" || code === "EPERM") {
        hint = `Upload path not writable. Set HOME_AD_UPLOAD_DIR to a writable cPanel path (current: ${getHomeAdsUploadDir()})`;
      } else if (code === "ENOENT") {
        hint = `Upload path not found. Check HOME_AD_UPLOAD_DIR (current: ${getHomeAdsUploadDir()})`;
      } else if (code === "ENOSPC") {
        hint = "Server disk is full (ENOSPC).";
      }
      if (!hint && pathValue) hint = `Upload path: ${pathValue}`;
      return sendInternalError(req, res, "admin/uploads/home-ads-binary", err, hint ? { hint } : {});
    }
  }
);

router.post(
  "/uploads/home-ads",
  adminAuth,
  express.json({ limit: "40mb" }),
  async (req, res) => {
    try {
      if (!requireSuperAdmin(req, res)) return;

      const slotKey = normStr(req.body?.slot_key, 32).toLowerCase();
      const kind = normStr(req.body?.kind, 32).toLowerCase();
      const fileName = normStr(req.body?.file_name, 255);
      const parsed = parseDataUrl(req.body?.data_url);

      if (!parsed) return res.status(400).json({ error: "invalid data_url" });

      const { mime, bytes } = parsed;
      return await storeHomeAdUpload(req, res, { slotKey, kind, fileName, mime, bytes });
    } catch (err) {
      const code = String(err?.code || "");
      const pathValue = String(err?.path || "");
      let hint = undefined;
      if (code === "EACCES" || code === "EPERM") {
        hint = `Upload path not writable. Set HOME_AD_UPLOAD_DIR to a writable cPanel path (current: ${getHomeAdsUploadDir()})`;
      } else if (code === "ENOENT") {
        hint = `Upload path not found. Check HOME_AD_UPLOAD_DIR (current: ${getHomeAdsUploadDir()})`;
      } else if (code === "ENOSPC") {
        hint = "Server disk is full (ENOSPC).";
      }
      if (!hint && pathValue) hint = `Upload path: ${pathValue}`;
      return sendInternalError(req, res, "admin/uploads/home-ads", err, hint ? { hint } : {});
    }
  }
);

module.exports = router;
