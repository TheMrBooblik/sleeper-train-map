import { useEffect, useState } from "react";
import { VIEW_CITIES, VIEW_MAP } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Cache structure
const viewMapCache = {
    data: null,
    timestamp: null
};

export function useViewMap() {
    const [viewMapData, setViewMapData] = useState({});
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const fetchCities = async () => {
            // Check if we need to fetch new data
            const currentTime = new Date().getTime();
            const shouldFetchData = !viewMapCache.data ||
              !viewMapCache.timestamp ||
              (currentTime - viewMapCache.timestamp > CACHE_DURATION);

            if (shouldFetchData) {
                setIsLoading(true);
                try {
                    const res = await fetch(`/api/trains?type=${VIEW_MAP}`);
                    const data = await res.json();

                    // Update the cache
                    viewMapCache.data = data;
                    viewMapCache.timestamp = currentTime;

                    // Update the state
                    setViewMapData(data || {});
                } catch (error) {
                    console.error("Error fetching cities:", error);
                    setViewMapData({});
                } finally {
                    setIsLoading(false);
                }
            } else {
                // Use cached data
                setViewMapData(viewMapCache.data || {});
            }
        };

        fetchCities();
    }, []);

    // Function to force refresh data
    const refreshCities = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/trains?type=${VIEW_MAP}`);
            const data = await res.json();

            // Update the cache
            viewMapCache.data = data;
            viewMapCache.timestamp = new Date().getTime();

            // Update the state
            setViewMapData(data || {});
        } catch (error) {
            console.error("Error refreshing cities:", error);
        } finally {
            setIsLoading(false);
        }
    };

    return {
        viewMapData,
        setViewMapData,
        isLoading,
        refreshCities,
        lastUpdated: viewMapCache.timestamp ? new Date(viewMapCache.timestamp) : null
    };
}