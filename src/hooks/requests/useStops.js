import { STOPS } from "../../constants/backOnTrack";
import { useEffect, useState } from "react";
import { enrichStationsWithCoordinates } from "../../helpers/enrichStationsWithCoordinates";
import { stationCoordinates } from "../../data/stationCoordinates";

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

          // Convert data object to array
          const stopsArray = Object.values(data) || [];

          // Enrich stations with coordinates
          // Priority: our custom coordinates first, then Open Night Train Database
          const enrichedStops = enrichStationsWithCoordinates(
            stopsArray,
            stationCoordinates,
          );

          // Update the cache with enriched data
          stopsCache.data = enrichedStops;
          stopsCache.timestamp = currentTime;

          // Update the state
          setStops(enrichedStops);
          setFilteredStops(enrichedStops);
        } catch (error) {
          console.error("Error fetching stations:", error);
          setStops([]);
          setFilteredStops([]);
        } finally {
          setIsLoading(false);
        }
      } else {
        // Use cached data
        // Handle backward compatibility: cache might be old format (object) or new format (array)
        let stopsArray = stopsCache.data || [];

        // If cache is in old format (object), convert to array
        if (!Array.isArray(stopsArray)) {
          stopsArray = Object.values(stopsArray) || [];
          // Re-enrich with coordinates in case cache format changed
          stopsArray = enrichStationsWithCoordinates(
            stopsArray,
            stationCoordinates,
          );
          // Update cache with new format
          stopsCache.data = stopsArray;
        }

        setStops(stopsArray);
        setFilteredStops(stopsArray);
      }
    };

    fetchStops();
  }, []);

  // Function to force refresh data
  const refreshStops = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/trains?type=${STOPS}`);
      const data = await response.json();

      // Convert data object to array
      const stopsArray = Object.values(data) || [];

      // Enrich stations with coordinates
      // Priority: our custom coordinates first, then Open Night Train Database
      const enrichedStops = enrichStationsWithCoordinates(
        stopsArray,
        stationCoordinates,
      );

      // Update the cache with enriched data
      stopsCache.data = enrichedStops;
      stopsCache.timestamp = new Date().getTime();

      // Update the state
      setStops(enrichedStops);
      setFilteredStops(enrichedStops);
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
    loadingProgress,
    refreshStops,
    lastUpdated: stopsCache.timestamp ? new Date(stopsCache.timestamp) : null,
  };
}
