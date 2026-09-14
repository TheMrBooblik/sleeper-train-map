// api/lib/resolve-payload.mjs
//
// Resolves the merged { stops, viewMap, trips } payload, in the tiered order
// /api/initial-data has always used:
//
//   1. the pre-merged artifact committed by scripts/canonicalize.mjs, when fresh
//   2. the daily-scrape file store, merged on the fly by buildInitialData()
//   3. Back-on-Track on GitHub, same merge (no NJ positions — scrape hasn't run)
//   4. the published artifact even when stale, rather than a 500 — the map must
//      never blank
//
// Extracted from the route so /api/route-geometry serves geometry lifted from
// exactly the same rows: the two responses are halves of one payload, and a
// route present in one but not the other would draw a line with no station or a
// station with no line.

import {
  getBlobData,
  getTrainsBySource,
  getPublishedInitialData,
  isFresh,
} from "./file-store.mjs";
import { buildInitialData, stripDisabledRoutes } from "./build-initial-data.mjs";
import SOURCE_REGISTRY from "../../../../data/sources/registry.json" with { type: "json" };
// Routes the admin turned off from the map. Applied at serve time (over both
// the published file and the fallback merge) so a toggle goes live on the next
// redeploy and is reversible — see admin Routes tab.
import DISABLED_ROUTES from "../../../../data/overrides/disabled-routes.json" with { type: "json" };

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

/**
 * @returns {Promise<{ data: object, source: string }>} merged payload with
 *   admin-disabled routes already stripped.
 * @throws when no tier could produce a payload.
 */
export async function resolveInitialPayload() {
  // Hoisted so the catch can serve it as a stale last resort (see below).
  let published = null;
  try {
    // Fast path: pre-merged dataset committed by the daily canonicalize step.
    published = await getPublishedInitialData();
    if (published && isFresh(published.uploadedAt)) {
      return {
        data: stripDisabledRoutes(published.data, DISABLED_ROUTES),
        source: "published",
      };
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

    // Review gate disabled for now: the fallback merge passes seenIndex: null
    // (allow-all), matching the un-gated published artifact from canonicalize.
    const payload = buildInitialData({
      stops: rawStops,
      viewMap: rawViewMap,
      trips: rawTrips,
      operatorTrains,
      seenIndex: null,
    });

    return { data: stripDisabledRoutes(payload, DISABLED_ROUTES), source };
  } catch (error) {
    // Last resort: if the fresh-data fallbacks failed (e.g. upstream serving a
    // corrupted file) but we have a committed published artifact, serve it even
    // when stale rather than 500 — the map must never blank.
    if (published?.data) {
      console.warn(
        "[resolve-payload] serving stale published artifact after fallback failure",
      );
      return {
        data: stripDisabledRoutes(published.data, DISABLED_ROUTES),
        source: "published-stale",
      };
    }
    throw error;
  }
}

/** CDN caches for 1 hour; serve stale while revalidating for up to 1 day. */
export function setCacheHeaders(res) {
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
  res.setHeader("Content-Type", "application/json");
}
