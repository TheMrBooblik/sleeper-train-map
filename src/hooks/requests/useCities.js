import { useEffect, useState } from "react";
import { VIEW_CITIES } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Cache structure
const citiesCache = {
    data: null,
    timestamp: null
};

export function useCities() {
    const [cities, setCities] = useState({});
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const fetchCities = async () => {
            // Check if we need to fetch new data
            const currentTime = new Date().getTime();
            const shouldFetchData = !citiesCache.data ||
              !citiesCache.timestamp ||
              (currentTime - citiesCache.timestamp > CACHE_DURATION);

            if (shouldFetchData) {
                setIsLoading(true);
                try {
                    const res = await fetch(`/api/trains?type=${VIEW_CITIES}`);
                    const data = await res.json();

                    // Update the cache
                    citiesCache.data = data;
                    citiesCache.timestamp = currentTime;

                    // Update the state
                    setCities(data || {});
                } catch (error) {
                    console.error("Error fetching cities:", error);
                    setCities({});
                } finally {
                    setIsLoading(false);
                }
            } else {
                // Use cached data
                setCities(citiesCache.data || {});
            }
        };

        fetchCities();
    }, []);

    // Function to force refresh data
    const refreshCities = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/trains?type=${VIEW_CITIES}`);
            const data = await res.json();

            // Update the cache
            citiesCache.data = data;
            citiesCache.timestamp = new Date().getTime();

            // Update the state
            setCities(data || {});
        } catch (error) {
            console.error("Error refreshing cities:", error);
        } finally {
            setIsLoading(false);
        }
    };

    return {
        cities,
        setCities,
        isLoading,
        refreshCities,
        lastUpdated: citiesCache.timestamp ? new Date(citiesCache.timestamp) : null
    };
}