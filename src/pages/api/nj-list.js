// pages/api/nj-list.js
// Lists cached Nightjet routes for a given date and optionally returns only the segments
// starting at a provided station name. Uses cache from nj-train/nj-prewarm (.next/cache or /tmp on Vercel).

import fs from "fs";
import path from "path";
import { discoverAllTrainNumbers } from "./lib/nj-discovery";
import { getCacheDir, ensureDir as ensureDirHelper } from "./lib/cache-dir";

const CACHE_DIR = getCacheDir("nightjet");

function ensureDir() {
  return ensureDirHelper(fs, CACHE_DIR);
}

function simplifyName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\b(centraal|central|bahnhof|station|hbf|hb)\b/gi, "")
    .replace(/[^a-z\s-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchName(a, b) {
  const A = simplifyName(a);
  const B = simplifyName(b);
  if (!A || !B) return false;
  return A === B || A.includes(B) || B.includes(A);
}

/** Read route items from cache files for a given date; optionally filter by station name. */
function readItemsFromCache(cacheDir, date, stationName) {
  let files = [];
  try {
    files = fs.readdirSync(cacheDir).filter((f) => f.endsWith(`${date}.json`));
  } catch {
    // Cache dir may not exist on Vercel cold start
  }
  const items = [];
  for (const f of files) {
    try {
      const p = path.join(cacheDir, f);
      const obj = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!obj?.stations?.length) continue;
      if (stationName) {
        const idx = obj.stations.findIndex((s) => matchName(stationName, s.name));
        if (idx < 0) continue;
      }
      const stations = obj.stations;
      const coords = stations
        .map((s) => [s?.location?.latitude, s?.location?.longitude])
        .filter(
          (a) =>
            Array.isArray(a) &&
            Number.isFinite(a[0]) &&
            Number.isFinite(a[1]),
        );
      items.push({
        key: `${obj.lineName}-${date}`,
        lineName: obj.lineName,
        operator: obj.operator || "Nightjet",
        date,
        stations,
        coords,
        polyline: obj.polyline || null,
      });
    } catch {}
  }
  return items;
}

export default async function handler(req, res) {
  try {
    const date = (
      req.query.date ||
      (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })()
    ).toString();
    const stationName = (req.query.stationName || "").toString();

    ensureDir();
    let items = readItemsFromCache(CACHE_DIR, date, stationName || "");

    // If no routes in cache (e.g. cold start), discover trains and prewarm cache, then re-read.
    const shouldDiscover = items.length === 0 || req.query.discover === "true";

    if (shouldDiscover) {
      try {
        const baseUrl = `${req.headers["x-forwarded-proto"] ? req.headers["x-forwarded-proto"] : "http"}://${req.headers.host}`;
        const trainNumbers = await discoverAllTrainNumbers(
          date,
          baseUrl,
          () => {},
        );

        const trainArray = Array.from(trainNumbers);
        const uncachedTrains = trainArray.filter((trainNumber) => {
          const cacheKey = `${trainNumber.replace(/\s+/g, "")}-${date}.json`;
          return !fs.existsSync(path.join(CACHE_DIR, cacheKey));
        });

        if (uncachedTrains.length > 0) {
          try {
            await fetch(
              `${baseUrl}/api/nj-prewarm?max=${uncachedTrains.length}&date=${encodeURIComponent(date)}`,
            );
          } catch (err) {
            console.error("[nj-list] Error calling nj-prewarm:", err);
          }
        }

        items = readItemsFromCache(CACHE_DIR, date, stationName || "");
      } catch (err) {
        console.error("[nj-list] Discovery error:", err);
        try {
          const url = `${req.headers["x-forwarded-proto"] ? req.headers["x-forwarded-proto"] : "http"}://${req.headers.host}/api/nj-prewarm?max=30&date=${encodeURIComponent(date)}`;
          await fetch(url);
        } catch {}
        items = readItemsFromCache(CACHE_DIR, date, stationName || "");
      }
    }

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    return res.status(200).json({ date, count: items.length, items });
  } catch (e) {
    console.error("[api/nj-list] error", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
