// pages/api/initial-data.js
// Combined endpoint: returns stops + viewMap + trips in one response.
//
// Fast path: serves the pre-merged dataset written by scripts/canonicalize.mjs
// (public/data/published/initial-data.json) when fresh.
// Fallback: loads raw sources (daily-scrape file store, then GitHub) and merges
// them on the fly via the shared buildInitialData() — identical output.
// Vercel CDN caches this for 1 hour so only ~1 serverless invocation per hour.

import {
  getBlobData,
  getNJTrains,
  getChineseTrains,
  getItalianTrains,
  getCaucasusTrains,
  getPublishedInitialData,
  isFresh,
} from "./lib/file-store";
import { buildInitialData } from "./lib/build-initial-data.mjs";

const BASE_URL =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

/**
 * Fetch a single Back-on-Track data type from GitHub.
 */
async function fetchType(type) {
  const response = await fetch(`${BASE_URL}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${type}: ${response.status}`);
  }
  return response.json();
}

function setCacheHeaders(res) {
  // CDN caches for 1 hour; serve stale while revalidating for up to 1 day.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
  res.setHeader("Content-Type", "application/json");
}

export default async function handler(req, res) {
  try {
    // Fast path: pre-merged dataset committed by the daily canonicalize step.
    const published = await getPublishedInitialData();
    if (published && isFresh(published.uploadedAt)) {
      console.log("[initial-data] source: published");
      setCacheHeaders(res);
      res.status(200).json(published.data);
      return;
    }

    let rawStops, rawViewMap, rawTrips;
    let source = "github";

    // Daily-scrape file store first (view_ontd_map already has nj_positions merged).
    const [blobStops, blobViewMap, blobTrips, njBlob, crBlob, itBlob, caucasusBlob] =
      await Promise.all([
        getBlobData("stops"),
        getBlobData("view_ontd_map"),
        getBlobData("trips"),
        getNJTrains(),
        getChineseTrains(),
        getItalianTrains(),
        getCaucasusTrains(),
      ]);

    if (
      blobStops && isFresh(blobStops.uploadedAt) &&
      blobViewMap && isFresh(blobViewMap.uploadedAt) &&
      blobTrips && isFresh(blobTrips.uploadedAt)
    ) {
      rawStops = blobStops.data;
      rawViewMap = blobViewMap.data;
      rawTrips = blobTrips.data;
      source = "file-store";
    } else {
      // Fall back to GitHub (no NJ positions — scrape hasn't run yet)
      [rawStops, rawViewMap, rawTrips] = await Promise.all([
        fetchType("stops"),
        fetchType("view_ontd_map"),
        fetchType("trips"),
      ]);
    }

    console.log(`[initial-data] source: ${source}`);

    const payload = buildInitialData({
      stops: rawStops,
      viewMap: rawViewMap,
      trips: rawTrips,
      njTrains: njBlob?.data?.trains ?? {},
      crTrains: crBlob?.data?.trains ?? {},
      itTrains: itBlob?.data?.trains ?? {},
      caucasusTrains: caucasusBlob?.data?.trains ?? {},
    });

    setCacheHeaders(res);
    res.status(200).json(payload);
  } catch (error) {
    console.error("[initial-data] Error:", error);
    res.status(500).json({ error: "Error fetching initial data" });
  }
}
