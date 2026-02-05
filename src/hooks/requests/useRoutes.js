import { useEffect, useState } from "react";
import { ROUTES } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000; // Set to 60 * 60 * 1000 for production

// Cache structure
const routesCache = {
  data: null,
  timestamp: null,
};

export function useRoutes() {
  const [routes, setRoutes] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
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
          const res = await fetch(`/api/trains?type=${ROUTES}`);
          const data = await res.json();

          // Update the cache
          routesCache.data = data;
          routesCache.timestamp = currentTime;

          // Update the state
          setRoutes(data || {});
        } catch (error) {
          console.error("Error fetching routes:", error);
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
  }, []);

  return {
    routes,
    isLoading,
    lastUpdated: routesCache.timestamp
      ? new Date(routesCache.timestamp)
      : null,
  };
}
