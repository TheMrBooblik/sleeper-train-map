// pages/api/route-geometry.js
// The encoded route polylines lifted out of /api/initial-data.
//
// They are ~1.05 MB of the 4.65 MB payload and the default first paint draws
// none of them: showRoutes starts false (Layout.js), so geometry is only needed
// once the user turns routes on or selects a station. Splitting it off lets the
// map paint stations from a ~120 KB gzip response instead of ~1.4 MB, and this
// half arrives in the background while they are already looking at the map.
//
// Same tiered resolution and CDN caching as /api/initial-data, so the two
// halves always describe the same set of routes.

import {
  resolveInitialPayload,
  setCacheHeaders,
} from "./lib/resolve-payload.mjs";
import { splitRouteGeometry } from "./lib/payload-projection.mjs";

export default async function handler(req, res) {
  try {
    const { data, source } = await resolveInitialPayload();
    console.log(`[route-geometry] source: ${source}`);

    const { geometry } = splitRouteGeometry(data);

    setCacheHeaders(res);
    res.status(200).json(geometry);
  } catch (error) {
    console.error("[route-geometry] Error:", error);
    res.status(500).json({ error: "Error fetching route geometry" });
  }
}
