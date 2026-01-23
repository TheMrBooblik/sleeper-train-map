import { useEffect, useState } from "react";
import { AGENCIES } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Cache structure
const agenciesCache = {
  data: null,
  timestamp: null,
};

export function useAgencies() {
  const [agencies, setAgencies] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchAgencies = async () => {
      // Check if we need to fetch new data
      const currentTime = new Date().getTime();
      const shouldFetchData =
        !agenciesCache.data ||
        !agenciesCache.timestamp ||
        currentTime - agenciesCache.timestamp > CACHE_DURATION;

      if (shouldFetchData) {
        setIsLoading(true);
        try {
          const res = await fetch(`/api/trains?type=${AGENCIES}`);
          const data = await res.json();

          // Update the cache
          agenciesCache.data = data;
          agenciesCache.timestamp = currentTime;

          // Update the state
          setAgencies(data || {});
        } catch (error) {
          console.error("Error fetching agencies:", error);
          setAgencies({});
        } finally {
          setIsLoading(false);
        }
      } else {
        // Use cached data
        setAgencies(agenciesCache.data || {});
      }
    };

    fetchAgencies();
  }, []);

  return {
    agencies,
    isLoading,
    lastUpdated: agenciesCache.timestamp
      ? new Date(agenciesCache.timestamp)
      : null,
  };
}
