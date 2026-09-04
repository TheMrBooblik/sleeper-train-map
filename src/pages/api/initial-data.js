// pages/api/initial-data.js
// Combined endpoint: returns stops + viewMap + trips in one response.
//
// The payload itself is resolved by api/lib/resolve-payload.mjs (published
// artifact → daily-scrape file store → GitHub → stale artifact). What this
// route adds is the projection down to what the map's first paint actually
// renders — see api/lib/payload-projection.mjs for why each part is dropped.
// Route geometry is served separately by /api/route-geometry and merged back in
// by the client once stations are on screen.
//
// Vercel CDN caches this for 1 hour so only ~1 serverless invocation per hour.

import { getGtfsBundleStationNames } from "./lib/file-store";
import {
  resolveInitialPayload,
  setCacheHeaders,
} from "./lib/resolve-payload.mjs";
import {
  projectStopsToRoutes,
  splitRouteGeometry,
  stripDeadTripColumns,
} from "./lib/payload-projection.mjs";

export default async function handler(req, res) {
  try {
    const { data, source } = await resolveInitialPayload();
    console.log(`[initial-data] source: ${source}`);

    const projected = stripDeadTripColumns(
      projectStopsToRoutes(data, getGtfsBundleStationNames()),
    );
    const { payload } = splitRouteGeometry(projected);

    setCacheHeaders(res);
    res.status(200).json(payload);
  } catch (error) {
    console.error("[initial-data] Error:", error);
    res.status(500).json({ error: "Error fetching initial data" });
  }
}
