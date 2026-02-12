/** =========================================
 *  ROUTES: Catalog + Content (JWT required) (CommonJS)
 *  ========================================= */
const { Router } = require("express");
const { authJwt } = require("../middleware/authJwt.cjs");
const { getDeviceUpstream } = require("../utils/upstreamAuth.cjs");
const { buildXuiPlayerApiUrl } = require("../utils/xui.cjs");

const router = Router();

/** =========================================
 *  HELPERS
 *  ========================================= */
function parseLimit(v, fallback = 20, max = 100) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, n));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function sortByAddedDesc(items) {
  return [...items].sort((a, b) => {
    const aAdded = Number(a?.added || 0);
    const bAdded = Number(b?.added || 0);
    return bAdded - aAdded;
  });
}

async function fetchXuiJson(upstream, action, params = {}) {
  const base = buildXuiPlayerApiUrl({
    upstream_base_url: upstream.upstream_base_url,
    username: upstream.username,
    password: upstream.password,
  });

  const url = new URL(base);
  if (action) url.searchParams.set("action", action);
  Object.entries(params).forEach(([k, val]) => {
    if (val === undefined || val === null || val === "") return;
    url.searchParams.set(k, String(val));
  });

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "User-Agent": "streamin-api/1.0" },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const err = new Error("upstream failed");
    err.status = resp.status;
    err.body = txt.slice(0, 200);
    throw err;
  }

  const txt = await resp.text();
  try {
    return JSON.parse(txt);
  } catch {
    const err = new Error("upstream returned invalid JSON");
    err.status = 502;
    err.body = txt.slice(0, 200);
    throw err;
  }
}

async function resolveUpstream(req, res) {
  try {
    const upstream = await getDeviceUpstream(req.device.device_id);
    if (!upstream) {
      res.status(404).json({ error: "no upstream configured for device" });
      return null;
    }
    return upstream;
  } catch (err) {
    if (err?.message === "missing upstream base URL") {
      res.status(500).json({ error: "missing upstream base URL" });
      return null;
    }
    throw err;
  }
}

/** =========================================
 *  GET /v1/catalog/home
 *  - rails (Trending, New, Live Now, Categories)
 *  ========================================= */
router.get("/catalog/home", authJwt, async (req, res) => {
  try {
    const upstream = await resolveUpstream(req, res);
    if (!upstream) return;

    const limit = parseLimit(req.query.limit, 20);

    const [liveStreams, vodStreams, liveCats, vodCats, seriesCats] =
      await Promise.all([
        fetchXuiJson(upstream, "get_live_streams"),
        fetchXuiJson(upstream, "get_vod_streams"),
        fetchXuiJson(upstream, "get_live_categories"),
        fetchXuiJson(upstream, "get_vod_categories"),
        fetchXuiJson(upstream, "get_series_categories"),
      ]);

    const liveList = asArray(liveStreams).slice(0, limit);
    const vodList = asArray(vodStreams);

    const newest = sortByAddedDesc(vodList).slice(0, limit);
    const trending = vodList.slice(0, limit);

    const categories = [
      ...asArray(liveCats).map((c) => ({
        id: String(c.category_id ?? ""),
        name: String(c.category_name ?? ""),
        type: "live",
      })),
      ...asArray(vodCats).map((c) => ({
        id: String(c.category_id ?? ""),
        name: String(c.category_name ?? ""),
        type: "vod",
      })),
      ...asArray(seriesCats).map((c) => ({
        id: String(c.category_id ?? ""),
        name: String(c.category_name ?? ""),
        type: "series",
      })),
    ].filter((c) => c.id && c.name);

    return res.json({
      rails: [
        { key: "trending", title: "Trending", type: "vod", items: trending },
        { key: "new", title: "New", type: "vod", items: newest },
        { key: "live_now", title: "Live Now", type: "live", items: liveList },
        { key: "categories", title: "Categories", type: "category", items: categories },
      ],
    });
  } catch (err) {
    console.error("[catalog/home] error:", err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "internal error",
      status,
      body: err?.body,
    });
  }
});

/** =========================================
 *  GET /v1/catalog/category/:id
 *  - query: type=live|vod|series
 *  ========================================= */
router.get("/catalog/category/:id", authJwt, async (req, res) => {
  try {
    const upstream = await resolveUpstream(req, res);
    if (!upstream) return;

    const categoryId = String(req.params.id || "").trim();
    if (!categoryId) return res.status(400).json({ error: "category id required" });

    const type = String(req.query.type || "").trim().toLowerCase();
    const limit = parseLimit(req.query.limit, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

    const typeMap = {
      live: "get_live_streams",
      vod: "get_vod_streams",
      series: "get_series",
    };

    const typesToTry = type ? [type] : ["live", "vod", "series"];

    for (const t of typesToTry) {
      const action = typeMap[t];
      if (!action) continue;

      const data = await fetchXuiJson(upstream, action, { category_id: categoryId });
      const items = asArray(data).slice(0, limit);
      if (items.length) {
        return res.json({ category_id: categoryId, type: t, items });
      }
    }

    return res.json({ category_id: categoryId, type: type || null, items: [] });
  } catch (err) {
    console.error("[catalog/category] error:", err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "internal error",
      status,
      body: err?.body,
    });
  }
});

/** =========================================
 *  GET /v1/content/:id
 *  - query: type=vod|series|live
 *  ========================================= */
router.get("/content/:id", authJwt, async (req, res) => {
  try {
    const upstream = await resolveUpstream(req, res);
    if (!upstream) return;

    const contentId = String(req.params.id || "").trim();
    if (!contentId) return res.status(400).json({ error: "content id required" });

    const type = String(req.query.type || "").trim().toLowerCase();
    const typeOrder = type ? [type] : ["vod", "series", "live"];
    const relatedLimit = parseLimit(req.query.related_limit, 20);

    for (const t of typeOrder) {
      if (t === "vod") {
        const data = await fetchXuiJson(upstream, "get_vod_info", {
          vod_id: contentId,
        });

        if (data && (data.info || data.movie_data)) {
          const categoryId =
            data?.info?.category_id || data?.movie_data?.category_id || null;
          let related = [];

          if (categoryId) {
            const vods = await fetchXuiJson(upstream, "get_vod_streams", {
              category_id: categoryId,
            });
            related = asArray(vods)
              .filter((item) => String(item.stream_id || "") !== contentId)
              .slice(0, relatedLimit);
          }

          return res.json({
            id: contentId,
            type: "vod",
            info: data.info || null,
            movie_data: data.movie_data || null,
            related,
          });
        }
      }

      if (t === "series") {
        const data = await fetchXuiJson(upstream, "get_series_info", {
          series_id: contentId,
        });

        if (data && (data.info || data.seasons || data.episodes)) {
          const categoryId = data?.info?.category_id || null;
          let related = [];

          if (categoryId) {
            const series = await fetchXuiJson(upstream, "get_series", {
              category_id: categoryId,
            });
            related = asArray(series)
              .filter((item) => String(item.series_id || "") !== contentId)
              .slice(0, relatedLimit);
          }

          return res.json({
            id: contentId,
            type: "series",
            info: data.info || null,
            seasons: data.seasons || null,
            episodes: data.episodes || null,
            related,
          });
        }
      }

      if (t === "live") {
        const streams = await fetchXuiJson(upstream, "get_live_streams");
        const match = asArray(streams).find(
          (item) => String(item.stream_id || "") === contentId
        );

        if (match) {
          const categoryId = match.category_id || null;
          let related = [];

          if (categoryId) {
            const live = await fetchXuiJson(upstream, "get_live_streams", {
              category_id: categoryId,
            });
            related = asArray(live)
              .filter((item) => String(item.stream_id || "") !== contentId)
              .slice(0, relatedLimit);
          }

          return res.json({
            id: contentId,
            type: "live",
            info: match,
            related,
          });
        }
      }
    }

    return res.status(404).json({ error: "content not found" });
  } catch (err) {
    console.error("[content] error:", err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "internal error",
      status,
      body: err?.body,
    });
  }
});

/** =========================================
 *  GET /v1/live
 *  ========================================= */
router.get("/live", authJwt, async (req, res) => {
  try {
    const upstream = await resolveUpstream(req, res);
    if (!upstream) return;

    const limit = parseLimit(req.query.limit, 200);
    const streams = await fetchXuiJson(upstream, "get_live_streams");
    return res.json({ live: asArray(streams).slice(0, limit) });
  } catch (err) {
    console.error("[live] error:", err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "internal error",
      status,
      body: err?.body,
    });
  }
});

module.exports = router;
