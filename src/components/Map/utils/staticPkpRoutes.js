/**
 * Static PKP routes that are not in Back-on-Track viewMap data but have
 * precomputed polylines in public/data. These are always included when
 * "Show all routes" is on so the lines appear on the map using *Polyline.json.
 */

// Route IDs we inject so they appear in the route list and get their polyline drawn.
export const STATIC_PKP_ROUTE_IDS = ["pkpUstronie"];

/**
 * Fallback positions (first and last from polyline) when station lookup fails.
 * Ensures the route still gets a path so the polyline can replace it when loaded.
 */
const USTRONIE_FALLBACK_POSITIONS = [
  [49.78368, 22.77644],
  [52.40155, 16.91102],
];

/**
 * Synthetic route objects for static PKP routes.
 * Station names must match stops (e.g. Back-on-Track/GTFS) so buildPathForDirection can resolve coords.
 * Route 138: Ustronie — Kraków→Kołobrzeg via Kielce, Radom, Gdańsk (TLK 38170 / TLK 83170).
 */
export const STATIC_PKP_ROUTES = {
  pkpUstronie: {
    route_id: "pkpUstronie",
    route_long_name: "Ustronie",
    origin_trip_0: "Kraków Główny",
    destination_trip_0: "Kołobrzeg",
    via_0: "Kielce - Radom - Gdańsk Główny",
    origin_trip_1: "Kołobrzeg",
    destination_trip_1: "Kraków Główny",
    via_1: "Gdańsk Główny - Radom - Kielce",
    fallbackPositions: USTRONIE_FALLBACK_POSITIONS,
  },
};
