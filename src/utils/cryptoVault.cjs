/** =========================================
 *  UTILS: AES-256-GCM encryption for upstream creds (CommonJS)
 *  ========================================= */
const crypto = require("crypto");
const { env } = require("../config/env.cjs");

if (!env.ENC_KEY_BASE64) {
  throw new Error("Missing ENV: ENC_KEY_BASE64 (base64-encoded 32-byte key)");
}

const KEY = Buffer.from(env.ENC_KEY_BASE64, "base64");

if (KEY.length !== 32) {
  throw new Error(`Invalid ENC_KEY_BASE64: expected 32 bytes after base64 decode, got ${KEY.length}`);
}

function encryptString(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

function decryptString(packed) {
  const [ivB64, tagB64, encB64] = String(packed).split(".");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Invalid encrypted payload format");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return plain.toString("utf8");
}

module.exports = { encryptString, decryptString };