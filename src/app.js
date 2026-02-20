/** =========================================
 *  PASSENGER APP: Express export (CommonJS)
 *  ========================================= */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { env } = require("./config/env.cjs");
const deviceRoutes = require("./routes/device.routes.cjs");
const playlistRoutes = require("./routes/playlist.routes.cjs");
const catalogRoutes = require("./routes/catalog.routes.cjs");
const playbackRoutes = require("./routes/playback.routes.cjs");
const analyticsRoutes = require("./routes/analytics.routes.cjs");
const epgRoutes = require("./routes/epg.routes.cjs");
const appUpdateRoutes = require("./routes/appUpdate.routes.cjs");
const notificationsRoutes = require("./routes/notifications.routes.cjs");
const adminRoutes = require("./routes/admin.routes.cjs");
const adminAppUpdateRoutes = require("./routes/admin.appUpdates.routes.cjs");
const adminNotificationsRoutes = require("./routes/admin.notifications.routes.cjs");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

const corsOptionsDelegate = (req, cb) => {
  const origin = req.header("Origin");
  const allowList = env.ALLOWED_ORIGINS || [];
  const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || "");

  const allowed =
    !origin || // non-browser/server calls
    origin === "null" || // webOS/simulator file:// origins
    !allowList.length || // permissive fallback when list is empty
    allowList.includes(origin) ||
    isLocalDev;

  return cb(null, {
    origin: allowed ? origin || true : false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: false,
    maxAge: 86400,
  });
};

app.use(cors(corsOptionsDelegate));
app.options("*", cors(corsOptionsDelegate));

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
app.use("/v1", catalogRoutes);
app.use("/v1", playbackRoutes);
app.use("/v1", analyticsRoutes);
app.use("/v1", epgRoutes);
app.use("/v1", appUpdateRoutes);
app.use("/v1", notificationsRoutes);
app.use("/v1/admin", adminRoutes);
app.use("/v1/admin", adminAppUpdateRoutes);
app.use("/v1/admin", adminNotificationsRoutes);


module.exports = app;
