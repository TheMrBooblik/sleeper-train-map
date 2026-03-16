// pages/api/nj-prewarm.js
// Prewarm Nightjet caches without hurting performance: discover NJ trains from Back-on-Track trips,
// fetch Nightjet's per-train endpoint, normalize, and write to cache (.next/cache or /tmp on Vercel).
// Uses shared fetchAndCacheTrains utility (same logic as nj-list in-process fetching).

import fs from "fs";
import { discoverAllTrainNumbers } from "./lib/nj-discovery";
import { getCacheDir, ensureDir as ensureDirHelper } from "./lib/cache-dir";
import { fetchAndCacheTrains } from "./lib/train-fetcher";

const CACHE_DIR = getCacheDir("nightjet");

function ensureDir() {
  return ensureDirHelper(fs, CACHE_DIR);
}

export default async function handler(req, res) {
  try {
    const max = Math.max(1, Math.min(50, parseInt(req.query.max ?? "12", 10)));
    const date = (
      req.query.date ||
      (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })()
    ).toString();

    // Discover all NightJet trains using shared discovery utility
    // This combines cache, Back-on-Track, and comprehensive API discovery
    const baseUrl = `${req.headers["x-forwarded-proto"] ? req.headers["x-forwarded-proto"] : "http"}://${req.headers.host}`;
    let trains = [];

    try {
      const trainNumbers = await discoverAllTrainNumbers(
        date,
        baseUrl,
        (progress) => {
          // console.log(`[nj-prewarm] ${progress.message}`)
        },
      );
      trains = Array.from(trainNumbers);
    } catch (err) {
      console.error("[nj-prewarm] Discovery failed:", err);
    }

    // Limit and prewarm with higher concurrency (6 workers) for faster loading
    trains = trains.slice(0, max);
    ensureDir();

    // Use shared fetchAndCacheTrains (same logic list endpoints use)
    const results = await fetchAndCacheTrains(CACHE_DIR, trains, date, {
      operator: "Nightjet",
      source: "nightjet-com",
      concurrency: 6,
    });

    return res.status(200).json({
      ok: true,
      date,
      requested: trains.length,
      ...results,
      trains,
    });
  } catch (e) {
    console.error("[api/nj-prewarm] error", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}
