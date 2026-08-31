import { useEffect, useState, useCallback } from "react";
import { enrichInitialData } from "../../lib/enrich-payload.mjs";

// Module-level cache: shared across all component instances, 1 hour TTL
const CACHE_DURATION = 60 * 60 * 1000;
const cache = { data: null, timestamp: null };

const warn = (message, error) =>
  console.warn(`[useInitialData] ${message}:`, error);

/**
 * Fetch the API payload and the three static GTFS blobs, then hand them to
 * `enrichInitialData`. A GTFS blob that fails to load or parse is passed as
 * null, which that function treats as "skip this merge" — same degradation as
 * before, now expressed once instead of twice.
 */
async function fetchAndEnrich() {
  const [dataRes, pkpRes, rjChopRes, rjPremyslRes] = await Promise.all([
    fetch("/api/initial-data"),
    fetch("/data/gtfs/pkpTrainShapes.json"),
    fetch("/data/gtfs/rjChopTimetable.json"),
    fetch("/data/gtfs/rjPremyslTimetable.json"),
  ]);
  if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status}`);

  const readJson = async (res, label) => {
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch (e) {
      warn(`${label} parse failed`, e);
      return null;
    }
  };

  const data = await dataRes.json();
  const pkpBundle = await readJson(pkpRes, "PKP GTFS bundle");
  const rjChopData = await readJson(rjChopRes, "RJ Chop timetable");
  const rjPremyslData = await readJson(rjPremyslRes, "RJ Přemysl timetable");

  return enrichInitialData({
    data,
    pkpBundle,
    rjChopData,
    rjPremyslData,
    onWarn: warn,
  });
}

/**
 * Combined hook: fetches stops, viewMap, and trips in a single request.
 * Replaces useStops + useCities + useViewMap + useTrips with one CDN-cached call.
 */
export function useInitialData() {
  const [stops, setStops] = useState([]);
  const [filteredStops, setFilteredStops] = useState([]);
  const [cities, setCities] = useState({});
  const [viewMapData, setViewMapData] = useState({});
  const [trips, setTrips] = useState({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      // Use module-level cache if fresh
      const now = Date.now();
      if (
        cache.data &&
        cache.timestamp &&
        now - cache.timestamp < CACHE_DURATION
      ) {
        setStops(cache.data.stops);
        setFilteredStops(cache.data.stops);
        setCities(cache.data.cities);
        setViewMapData(cache.data.viewMapData);
        setTrips(cache.data.trips);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const enriched = await fetchAndEnrich();

        cache.data = enriched;
        cache.timestamp = now;

        setStops(enriched.stops);
        setFilteredStops(enriched.stops);
        setCities(enriched.cities);
        setViewMapData(enriched.viewMapData);
        setTrips(enriched.trips);
      } catch (err) {
        console.error("[useInitialData] Error:", err);
        setStops([]);
        setFilteredStops([]);
        setCities({});
        setViewMapData({});
        setTrips({});
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, []);

  const refreshData = useCallback(async () => {
    setIsLoading(true);
    try {
      const enriched = await fetchAndEnrich();

      cache.data = enriched;
      cache.timestamp = Date.now();

      setStops(enriched.stops);
      setFilteredStops(enriched.stops);
      setCities(enriched.cities);
      setViewMapData(enriched.viewMapData);
      setTrips(enriched.trips);
    } catch (err) {
      console.error("[useInitialData] Refresh error:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    stops,
    filteredStops,
    setFilteredStops,
    cities,
    viewMapData,
    trips,
    isLoading,
    refreshData,
  };
}
