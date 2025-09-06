import { STOPS } from "../../constants/backOnTrack";
import { useEffect, useState } from "react";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Cache structure
const stopsCache = {
  data: null,
  timestamp: null,
};

export function useStops() {
  const [stops, setStops] = useState([]);
  const [selectedStop, setSelectedStop] = useState();
  const [filteredStops, setFilteredStops] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);

  useEffect(() => {
    const fetchStops = async () => {
      // Check if we need to fetch new data
      const currentTime = new Date().getTime();
      const shouldFetchData =
        !stopsCache.data ||
        !stopsCache.timestamp ||
        currentTime - stopsCache.timestamp > CACHE_DURATION;

      if (shouldFetchData) {
        setIsLoading(true);
        try {
          const response = await fetch(`/api/trains?type=${STOPS}`);
          const data = await response.json();

          // Update the cache
          stopsCache.data = data;
          stopsCache.timestamp = currentTime;

          // Update the state
          const stopsArray = Object.values(data) || [];
          setStops(stopsArray);
          setFilteredStops(stopsArray);
        } catch (error) {
          console.error("Error fetching stations:", error);
          setStops([]);
          setFilteredStops([]);
        } finally {
          setIsLoading(false);
        }
      } else {
        // Use cached data
        const stopsArray = Object.values(stopsCache.data) || [];
        setStops(stopsArray);
        setFilteredStops(stopsArray);
      }
    };

    fetchStops();
  }, []);

  return { stops, filteredStops, setFilteredStops, isLoading, loadingProgress };

  // Function to force refresh data
  const refreshStops = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/trains?type=${STOPS}`);
      const data = await response.json();

      // Update the cache
      stopsCache.data = data;
      stopsCache.timestamp = new Date().getTime();

      // Update the state
      const stopsArray = Object.values(data) || [];
      setStops(stopsArray);
      setFilteredStops(stopsArray);
    } catch (error) {
      console.error("Error refreshing stations:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    stops,
    selectedStop,
    setSelectedStop,
    filteredStops,
    setFilteredStops,
    isLoading,
    refreshStops,
    lastUpdated: stopsCache.timestamp ? new Date(stopsCache.timestamp) : null,
  };
}
