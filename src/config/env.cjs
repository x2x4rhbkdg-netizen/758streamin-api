/** =========================
 *  ENV (Passenger CommonJS)
 *  ========================= */
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}

function list(name) {
  const v = (process.env[name] || "").trim();
  if (!v) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: Number(process.env.PORT || 3000),

  JWT_SECRET: must("JWT_SECRET"),
  ADMIN_API_KEY: must("ADMIN_API_KEY"),
  ENC_KEY_BASE64: must("ENC_KEY_BASE64"),

  ALLOWED_ORIGINS: list("ALLOWED_ORIGINS"),

DB_HOST: must("DB_HOST"),
DB_USER: must("DB_USER"),
DB_PASSWORD: must("DB_PASSWORD"),
DB_NAME: must("DB_NAME"),
DB_PORT: process.env.DB_PORT || 3306,

};

module.exports = { env };