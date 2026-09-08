import { useEffect, useState } from "react";
import { TRIPS } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Cache structure
const tripsCache = {
  data: null,
  timestamp: null,
};

/**
 * @param {{ enabled?: boolean }} [options] `enabled: false` skips the fetch —
 *   see useRoutes for why (this one is ~27 KB gzip of the same duplication).
 */
export function useTrips({ enabled = true } = {}) {
  const [trips, setTrips] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const fetchTrips = async () => {
      // Check if we need to fetch new data
      const currentTime = new Date().getTime();
      const shouldFetchData =
        !tripsCache.data ||
        !tripsCache.timestamp ||
        currentTime - tripsCache.timestamp > CACHE_DURATION;

      if (shouldFetchData) {
        setIsLoading(true);
        try {
          const res = await fetch(`/api/trains?type=${TRIPS}`);
          const data = await res.json();

          // Update the cache
          tripsCache.data = data;
          tripsCache.timestamp = currentTime;

          // Update the state
          setTrips(data || {});
        } catch (error) {
          console.error("Error fetching trips:", error);
          setTrips({});
        } finally {
          setIsLoading(false);
        }
      } else {
        // Use cached data
        setTrips(tripsCache.data || {});
      }
    };

    fetchTrips();
  }, [enabled]);

  return {
    trips,
    isLoading,
    lastUpdated: tripsCache.timestamp ? new Date(tripsCache.timestamp) : null,
  };
}
