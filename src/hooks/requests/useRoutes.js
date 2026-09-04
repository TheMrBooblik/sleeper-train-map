import { useEffect, useState } from "react";
import { VIEW_MAP } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000; // Set to 60 * 60 * 1000 for production

// Cache structure — stores routes keyed by route_id string (same shape consumers expect).
const routesCache = {
  data: null,
  timestamp: null,
};

/**
 * Turn `view_ontd_map.json` (object keyed arbitrarily or array of rows) into a plain
 * record: { [routeId]: row }. Trips use `route_id`; lookups must work with string or number.
 *
 * We use the map feed instead of GTFS `routes.json` so route metadata matches what the map draws.
 *
 * @param {Record<string, unknown>|unknown[]|null|undefined} raw - API JSON body
 * @returns {Record<string, object>}
 */
function normalizeViewMapToRoutesRecord(raw) {
  if (!raw) return {};

  const rows = Array.isArray(raw) ? raw : Object.values(raw);
  /** @type {Record<string, object>} */
  const byId = {};

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = row.route_id;
    if (id === undefined || id === null) continue;
    const key = id.toString();
    // One entry per route_id; last wins if duplicates exist (should not happen).
    byId[key] = row;
  }

  return byId;
}

/**
 * @param {{ enabled?: boolean }} [options] `enabled: false` skips the fetch
 *   entirely — for callers that already hold this data and only keep the hook
 *   as a standalone fallback. `/api/trains?type=view_ontd_map` is ~118 KB gzip,
 *   so fetching it to then discard it is the single largest avoidable request
 *   on the map page.
 */
export function useRoutes({ enabled = true } = {}) {
  const [routes, setRoutes] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const fetchRoutes = async () => {
      // Check if we need to fetch new data
      const currentTime = new Date().getTime();
      const shouldFetchData =
        !routesCache.data ||
        !routesCache.timestamp ||
        currentTime - routesCache.timestamp > CACHE_DURATION;

      if (shouldFetchData) {
        setIsLoading(true);
        try {
          // Back-on-Track map view: same source as useInitialData / useRoutePaths.
          const res = await fetch(`/api/trains?type=${VIEW_MAP}`);
          const data = await res.json();

          const normalized = normalizeViewMapToRoutesRecord(data);

          // Update the cache
          routesCache.data = normalized;
          routesCache.timestamp = currentTime;

          // Update the state
          setRoutes(normalized);
        } catch (error) {
          console.error("Error fetching routes (view_ontd_map):", error);
          setRoutes({});
        } finally {
          setIsLoading(false);
        }
      } else {
        // Use cached data
        setRoutes(routesCache.data || {});
      }
    };

    fetchRoutes();
  }, [enabled]);

  return {
    routes,
    isLoading,
    lastUpdated: routesCache.timestamp
      ? new Date(routesCache.timestamp)
      : null,
  };
}
