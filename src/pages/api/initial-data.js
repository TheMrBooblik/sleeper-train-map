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
  getTrainsBySource,
  getPublishedInitialData,
  isFresh,
} from "./lib/file-store";
import { buildInitialData, stripDisabledRoutes } from "./lib/build-initial-data.mjs";
import SOURCE_REGISTRY from "../../../data/sources/registry.json" with { type: "json" };
// Review-gate approval index, bundled at build time. The published fast path
// is already gated by canonicalize; this covers the on-the-fly fallback merge.
import SEEN_INDEX from "../../../data/canonical/state/seen.json" with { type: "json" };
// Routes the admin turned off from the map. Applied here at serve time (over
// both the published file and the fallback merge) so a toggle goes live on the
// next redeploy and is reversible — see admin Routes tab.
import DISABLED_ROUTES from "../../../data/overrides/disabled-routes.json" with { type: "json" };

// Operator train sources that feed the merge (declared in the registry).
const TRAIN_SOURCE_ENTRIES = SOURCE_REGISTRY.filter(
  (e) => e.enabled && e.synthetic && e.output,
);

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
      res.status(200).json(stripDisabledRoutes(published.data, DISABLED_ROUTES));
      return;
    }

    let rawStops, rawViewMap, rawTrips;
    let source = "github";

    // Daily-scrape file store first (view_ontd_map already has nj_positions merged).
    const [blobStops, blobViewMap, blobTrips, ...trainBlobs] =
      await Promise.all([
        getBlobData("stops"),
        getBlobData("view_ontd_map"),
        getBlobData("trips"),
        ...TRAIN_SOURCE_ENTRIES.map((e) => getTrainsBySource(e.output)),
      ]);

    const operatorTrains = {};
    TRAIN_SOURCE_ENTRIES.forEach((e, i) => {
      operatorTrains[e.id] = trainBlobs[i]?.data?.trains ?? {};
    });

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
      operatorTrains,
      seenIndex: SEEN_INDEX,
    });

    setCacheHeaders(res);
    res.status(200).json(stripDisabledRoutes(payload, DISABLED_ROUTES));
  } catch (error) {
    console.error("[initial-data] Error:", error);
    res.status(500).json({ error: "Error fetching initial data" });
  }
}
