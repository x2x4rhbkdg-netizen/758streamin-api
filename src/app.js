    /** =========================================
 *  PASSENGER APP: Express export (CommonJS)
 *  ========================================= */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { env } = require("./config/env.cjs");                 
const deviceRoutes = require("./routes/device.routes.cjs");
const playlistRoutes = require("./routes/playlist.routes.cjs");
const adminRoutes = require("./routes/admin.routes.cjs");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!env.ALLOWED_ORIGINS.length) return cb(null, true);
    return env.ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("CORS blocked"));
  }
}));

//app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
/** =========================================
 *  ROOT
 *  ========================================= */
app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "758streamin API",
    docs: "/health",
    version: "v1"
  });
});
app.use("/v1", deviceRoutes);
app.use("/v1", playlistRoutes);
app.use("/v1/admin", adminRoutes);


module.exports = app;