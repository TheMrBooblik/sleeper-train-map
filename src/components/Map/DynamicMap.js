"use client";

import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
} from "react";
import Leaflet from "leaflet";
import * as ReactLeaflet from "react-leaflet";

const { MapContainer, Marker, TileLayer, Tooltip, Polyline } = ReactLeaflet;
import "leaflet/dist/leaflet.css";

import styles from "./Map.module.scss";
import Filter from "src/components/Filter";
import MarkerTooltip from "@components/MarkerTooltip";
import { useStops } from "../../hooks/requests/useStops";
import { useCities } from "../../hooks/requests/useCities";
import { normalizeStationNameForLookup } from "../../hooks/requests/useCities";
import { useViewMap } from "../../hooks/requests/useViewMap";
import TrainSidebar from "@components/TrainSidebar";
import ZoomControl from "@components/ZoomControl";
import LocationControl from "@components/LocationControl";

const Map = ({
  children,
  className,
  isGrouped,
  setIsGrouped,
  showRoutes = true,
  ...rest
}) => {
  const [sidebarDisabled, setSidebarDisabled] = useState(false);
  const {
    stops,
    filteredStops,
    setFilteredStops,
    isLoading: stopsLoading,
  } = useStops();
  const { cities, isLoading: citiesLoading, refreshCities } = useCities();
  const { viewMapData } = useViewMap(); // Add viewMapData to check station types
  const [selected, setSelected] = useState(false);
  const [stopId, setStopId] = useState();
  const [isMapInitialized, setIsMapInitialized] = useState(false);
  const [showTooltips, setShowTooltips] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [stopRouteIds, setStopRouteIds] = useState();
  const [currentZoom, setCurrentZoom] = useState(5);
  const [selectedStationName, setSelectedStationName] = useState("");
  const [selectedNormalizedName, setSelectedNormalizedName] = useState(""); // For filtering via stations
  const mapRef = useRef();
  const sidebarRef = useRef(null);

  const mapClassName = className ? `${styles.map} ${className}` : styles.map;

  // Function to normalize station name for display
  const normalizeStationName = useCallback((stationName) => {
    if (!stationName) return stationName;

    // Group Paris stations together
    if (stationName.includes("Paris")) {
      return "Paris";
    }
    // Group Brussels stations together
    else if (
      stationName.includes("Bruxelles") ||
      stationName.includes("Brussels")
    ) {
      return "Brussels";
    }
    // Group other major cities with multiple stations
    else if (
      stationName.includes("Antwerpen") ||
      stationName.includes("Antwerp")
    ) {
      return "Antwerpen";
    } else if (
      stationName.includes("Liège") ||
      stationName.includes("Liege") ||
      stationName.includes("Luik")
    ) {
      return "Liège";
    } else if (stationName.includes("Wien") || stationName.includes("Vienna")) {
      return "Vienna";
    } else if (
      stationName.includes("Milano") ||
      stationName.includes("Milan")
    ) {
      return "Milan";
    } else if (stationName.includes("Roma") || stationName.includes("Rome")) {
      return "Rome";
    } else if (stationName.includes("Berlin")) {
      return "Berlin";
    } else if (
      stationName.includes("München") ||
      stationName.includes("Munich")
    ) {
      return "Munich";
    } else if (stationName.includes("Hamburg")) {
      return "Hamburg";
    } else if (
      stationName.includes("Köln") ||
      stationName.includes("Cologne")
    ) {
      return "Cologne";
    } else if (stationName.includes("Frankfurt")) {
      return "Frankfurt";
    } else if (stationName.includes("Amsterdam")) {
      return "Amsterdam";
    } else if (
      stationName.includes("Zürich") ||
      stationName.includes("Zurich")
    ) {
      return "Zurich";
    } else if (stationName.includes("Barcelona")) {
      return "Barcelona";
    } else if (stationName.includes("Madrid")) {
      return "Madrid";
    } else if (
      stationName.includes("Lisboa") ||
      stationName.includes("Lisbon")
    ) {
      return "Lisbon";
    } else if (stationName.includes("Stockholm")) {
      return "Stockholm";
    } else if (stationName.includes("Oslo")) {
      return "Oslo";
    } else if (
      stationName.includes("København") ||
      stationName.includes("Copenhagen")
    ) {
      return "Copenhagen";
    } else if (
      stationName.includes("Helsinki") ||
      stationName.includes("Helsingfors")
    ) {
      return "Helsinki";
    } else if (
      stationName.includes("Warszawa") ||
      stationName.includes("Warsaw")
    ) {
      return "Warsaw";
    } else if (
      stationName.includes("Kraków") ||
      stationName.includes("Krakow")
    ) {
      return "Krakow";
    } else if (stationName.includes("Budapest")) {
      return "Budapest";
    } else if (
      stationName.includes("Praha") ||
      stationName.includes("Prague")
    ) {
      return "Prague";
    } else if (
      stationName.includes("București") ||
      stationName.includes("Bucharest")
    ) {
      return "Bucharest";
    } else if (stationName.includes("Sofia")) {
      return "Sofia";
    } else if (stationName.includes("Zagreb")) {
      return "Zagreb";
    } else if (stationName.includes("Ljubljana")) {
      return "Ljubljana";
    } else if (stationName.includes("Bratislava")) {
      return "Bratislava";
    } else if (stationName.includes("Vilnius")) {
      return "Vilnius";
    } else if (stationName.includes("Riga")) {
      return "Riga";
    } else if (stationName.includes("Tallinn")) {
      return "Tallinn";
    } else if (stationName.includes("Kyiv") || stationName.includes("Kiev")) {
      return "Kyiv";
    } else if (stationName.includes("Minsk")) {
      return "Minsk";
    } else if (stationName.includes("Ankara")) {
      return "Ankara";
    } else if (stationName.includes("London")) {
      return "London";
    } else if (
      stationName.includes("İstanbul") ||
      stationName.includes("Istanbul")
    ) {
      return "Istanbul";
    } else if (stationName.includes("İzmir") || stationName.includes("Izmir")) {
      return "Izmir";
    }

    return stationName;
  }, []);

  const removeFilter = () => {
    setStopId(null);
    setSelected(false);
    setSelectedStationName("");
    setSelectedNormalizedName("");
    setStopRouteIds([]); // Clear route IDs to hide route paths
    setFilteredStops(stops);
  };

  const escFunction = useCallback(
    (event) => {
      if (event.key === "Escape") {
        removeFilter();
      }
    },
    [setFilteredStops, stops],
  );

  useEffect(() => {
    document.addEventListener("keydown", escFunction, false);

    return () => {
      document.removeEventListener("keydown", escFunction, false);
    };
  }, [escFunction]);

  // Calculate overall loading state
  const overallLoading = stopsLoading || citiesLoading;

  // Progress animation effect
  useEffect(() => {
    if (overallLoading) {
      setLoadingProgress(0);
      const interval = setInterval(() => {
        setLoadingProgress((prev) => {
          if (prev >= 99) {
            clearInterval(interval);
            return 99; // Stop at 99% until actually loaded
          }
          return prev + Math.random() * 3; // Random increment for smooth progress
        });
      }, 100);

      return () => clearInterval(interval);
    } else {
      // Complete the progress when loading is done
      setLoadingProgress(100);
      setTimeout(() => {
        setIsLoading(false);
      }, 500); // Small delay to show 100% completion
    }
  }, [overallLoading]);

  // Immediate loading of map elements without delay
  useEffect(() => {
    if (stops && stops.length > 0 && cities && !overallLoading) {
      // Set everything immediately to show stations on first load
      setIsMapInitialized(true);
      setShowTooltips(true);

      // Ensure filtered stops is set to all stops initially
      setFilteredStops(stops);
    }
  }, [stops, cities, setFilteredStops, overallLoading]);

  const defaultIcon = useMemo(() => {
    // Create a beautiful blue dot for main stations
    const stationDot = new Leaflet.DivIcon({
      className: "station-dot",
      html: '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    return stationDot;
  }, []);

  const selectedIcon = useMemo(() => {
    // Create a beautiful dot for selected stations (same size as main stations)
    const selectedDot = new Leaflet.DivIcon({
      className: "selected-station-dot",
      html: '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #FF5722, #E64A19); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(255, 87, 34, 0.5), 0 0 0 1px rgba(255, 87, 34, 0.3); transition: all 0.3s ease; cursor: pointer; z-index: 2000;"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    return selectedDot;
  }, []);

  const viaIcon = useMemo(() => {
    // Create a bigger circular dot for intermediate stations
    const dotIcon = new Leaflet.DivIcon({
      className: "via-dot",
      html: '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    return dotIcon;
  }, []);

  const handleMarkerClick = useCallback(
    (filteredStop) => {
      const { stop_id } = filteredStop;

      // If clicking on the already selected marker, unselect it
      if (stopId === stop_id && selected) {
        removeFilter();
        return;
      }

      setStopId(stop_id);
      // IMPORTANT: Normalize stop_id before looking it up in cities
      // Use normalizeStationNameForLookup for matching city keys
      const normalizedStopId = normalizeStationNameForLookup(stop_id);
      const cityInfo = cities[normalizedStopId] || cities[stop_id];

      if (!cityInfo || !cityInfo.stop_route_ids) return;

      // Set station name based on grouping state
      const filterName = isGrouped ? normalizeStationName(stop_id) : stop_id;
      setSelectedStationName(filterName);

      // Set normalized name for filtering via stations
      setSelectedNormalizedName(normalizeStationName(stop_id));

      const { stop_route_ids } = cityInfo;

      // If this is a grouped marker, collect all route IDs from all stations in the group
      let routeIdsArray;
      if (filteredStop.isGrouped && filteredStop.groupedStations) {
        // Collect all route IDs from all stations in the group
        const allRouteIds = new Set();
        filteredStop.groupedStations.forEach((station) => {
          // IMPORTANT: Normalize station.stop_id before looking it up in cities
          // Use normalizeStationNameForLookup for matching city keys
          const normalizedId = normalizeStationNameForLookup(station.stop_id);
          const stationInfo = cities[normalizedId] || cities[station.stop_id];
          if (stationInfo?.stop_route_ids) {
            stationInfo.stop_route_ids.split(",").forEach((id) => {
              allRouteIds.add(id);
            });
          }
        });
        routeIdsArray = Array.from(allRouteIds);
      } else {
        routeIdsArray = stop_route_ids.split(",").filter((el) => el);
      }

      setStopRouteIds(routeIdsArray);

      // Find all cities (stations) that are part of the selected routes
      const routeCities = Object.values(cities).filter((viewCity) => {
        if (!viewCity || !viewCity.stop_route_ids) return false;
        const arr = viewCity.stop_route_ids.split(",");
        return arr.some((item) => routeIdsArray.includes(item));
      });

      // PERFORMANCE: Create Map for fast station lookup
      // Key: normalized station name, Value: stop object
      const stopsMap = new window.Map();
      stops.forEach((stop) => {
        if (!stop.stop_id) return;
        const normalizedId = normalizeStationNameForLookup(stop.stop_id);
        // Store by normalized name (primary key)
        if (!stopsMap.has(normalizedId)) {
          stopsMap.set(normalizedId, stop);
        }
        // Also store by original name for fallback
        if (!stopsMap.has(stop.stop_id)) {
          stopsMap.set(stop.stop_id, stop);
        }
      });

      // Find stops that match route cities
      const routeStops = routeCities
        .map((city) => {
          // city.stop_id is normalized, so use it directly for lookup
          return stopsMap.get(city.stop_id);
        })
        .filter(Boolean);

      // IMPORTANT: Set filtered stops to only show stations from selected routes
      // This hides all other stations when a filter is applied
      setFilteredStops(routeStops);
      setSelected(true);
    },
    [
      cities,
      stops,
      setFilteredStops,
      stopId,
      selected,
      removeFilter,
      normalizeStationName,
      normalizeStationNameForLookup,
      isGrouped,
    ],
  );

  // Function to group overlapping city markers based on toggle
  const groupCityMarkers = useCallback(
    (stops) => {
      if (!stops || !stops.length) return [];

      // If grouping is disabled, return individual stations
      if (!isGrouped) {
        return stops.map((stop) => ({
          ...stop,
          originalName: stop.stop_id,
          normalizedName: stop.stop_id,
          displayName: stop.stop_id,
          isGrouped: false,
        }));
      }

      // Group stations by city name (normalized)
      const cityGroups = {};

      stops.forEach((stop) => {
        if (!stop?.stop_id || !stop?.stop_lat || !stop?.stop_lon) return;

        // IMPORTANT: Normalize stop_id before looking it up in cities
        // Use normalizeStationNameForLookup for matching city keys
        const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
        const cityInfo = cities[normalizedStopId] || cities[stop.stop_id];
        if (!cityInfo?.stop_route_ids) return;

        // Use normalizeStationName for grouping (returns city name like "Antwerpen")
        const normalizedCityName = normalizeStationName(stop.stop_id);

        if (!cityGroups[normalizedCityName]) {
          cityGroups[normalizedCityName] = [];
        }

        cityGroups[normalizedCityName].push({
          ...stop,
          originalName: stop.stop_id,
          normalizedName: normalizedCityName,
        });
      });

      // Convert groups to individual markers or grouped markers
      const groupedMarkers = [];

      Object.entries(cityGroups).forEach(([cityName, stations]) => {
        if (stations.length === 1) {
          // Single station - show as normal marker
          groupedMarkers.push({
            ...stations[0],
            displayName: cityName,
            isGrouped: false,
          });
        } else {
          // Multiple stations - create grouped marker
          // Calculate average position for grouped stations
          const avgLat =
            stations.reduce((sum, station) => sum + station.stop_lat, 0) /
            stations.length;
          const avgLon =
            stations.reduce((sum, station) => sum + station.stop_lon, 0) /
            stations.length;

          // Find the most important station (main station, not via station)
          const mainStation =
            stations.find((station) => {
              // Use normalizeStationNameForLookup for matching city keys
              const normalizedId = normalizeStationNameForLookup(
                station.stop_id,
              );
              const cityInfo = cities[normalizedId] || cities[station.stop_id];
              return cityInfo && !cityInfo.isViaStation;
            }) || stations[0];

          groupedMarkers.push({
            ...mainStation,
            stop_lat: avgLat,
            stop_lon: avgLon,
            groupedStations: stations,
            isGrouped: true,
            groupSize: stations.length,
            displayName: cityName,
          });
        }
      });

      return groupedMarkers;
    },
    [cities, normalizeStationName, isGrouped],
  );

  const markers = useMemo(() => {
    if (!filteredStops || !filteredStops.length) return [];

    // Group overlapping city markers based on current zoom
    const groupedStops = groupCityMarkers(filteredStops);

    // PERFORMANCE OPTIMIZATION: Create Maps for fast lookups
    // This avoids repeated expensive operations
    // Note: Use window.Map to avoid conflict with component name
    const routeIdMap = new window.Map();
    const normalizedNameCache = new window.Map();

    // Cache route lookups
    if (selected && stopRouteIds && stopRouteIds.length > 0) {
      Object.values(viewMapData).forEach((route) => {
        if (route?.route_id) {
          routeIdMap.set(route.route_id.toString(), route);
        }
      });
    }

    // Helper to get cached normalized name for lookup in cities
    // This uses normalizeStationNameForLookup (not grouping function)
    const getCachedNormalizedName = (name) => {
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    return groupedStops
      .map((filteredStop, index) => {
        // For grouped stations, check if ANY station in the group is selected
        const isSelected = filteredStop.isGrouped
          ? filteredStop.groupedStations?.some(
              (station) => station.stop_id === stopId,
            )
          : stopId === filteredStop?.stop_id;
        const stopLat = filteredStop?.stop_lat;
        const stopLon = filteredStop?.stop_lon;

        const { stop_id } = filteredStop;
        // IMPORTANT: Normalize stop_id before looking it up in cities
        // because cities keys are normalized (e.g., "Antwerpen Centraal")
        // but stops may have original names (e.g., "Antwerpen-Centraal / Anvers-Central")
        const normalizedStopId = getCachedNormalizedName(stop_id);
        const cityInfo = cities[normalizedStopId] || cities[stop_id];
        const { stop_route_ids } = cityInfo || {};

        if (!stopLat || !stopLon || !stop_route_ids || !cityInfo) return null;

        // When filter is applied, ensure this station is part of selected routes
        // This provides an extra safety check to hide unrelated stations
        if (selected && stopRouteIds && stopRouteIds.length > 0) {
          const stationRouteIds = stop_route_ids
            .split(",")
            .filter((id) => id.trim());
          const isPartOfSelectedRoutes = stationRouteIds.some((id) =>
            stopRouteIds.includes(id),
          );
          if (!isPartOfSelectedRoutes) {
            return null; // Hide station if it's not part of selected routes
          }
        }

        // Dynamically determine if this station is a via station for the FILTERED routes
        // This fixes the bug where stations that are origins for OTHER routes
        // incorrectly show as origins instead of via stations
        let isViaStationForFilteredRoutes = cityInfo.isViaStation; // Default to global flag

        if (
          selected &&
          stopRouteIds &&
          stopRouteIds.length > 0 &&
          !isSelected
        ) {
          // When a filter is active, check if this station is origin/destination
          // for ANY of the filtered routes

          // Normalize the stop_id for comparison
          // For grouped stations, we need to check all stations in the group
          const stationsToCheck =
            filteredStop.isGrouped && filteredStop.groupedStations
              ? filteredStop.groupedStations.map((s) => s.stop_id)
              : [stop_id];

          const isOriginOrDestination = stopRouteIds.some((routeId) => {
            // PERFORMANCE: Use Map for O(1) lookup instead of O(n) find
            const route = routeIdMap.get(routeId);
            if (!route) return false;

            // Get all origin/destination names from the route
            const routeStations = [
              route.origin_trip_0,
              route.destination_trip_0,
              route.origin_trip_1,
              route.destination_trip_1,
            ].filter(Boolean);

            // Check if any of our stations (normalized) match any route station (normalized)
            // Use cached normalized names for better performance
            return stationsToCheck.some((stationId) => {
              const normalizedStationId = getCachedNormalizedName(stationId);
              return routeStations.some((routeStation) => {
                const normalizedRouteStation =
                  getCachedNormalizedName(routeStation);
                // Also check direct match for non-normalized names
                return (
                  routeStation === stationId ||
                  normalizedRouteStation === normalizedStationId ||
                  normalizedRouteStation === stationId ||
                  routeStation === normalizedStationId
                );
              });
            });
          });

          // If this station is NOT origin/destination for any filtered route,
          // then it must be a via station (even if globally it's a main station)
          isViaStationForFilteredRoutes = !isOriginOrDestination;
        }

        // Choose the appropriate icon based on station type and selection
        let iconToUse = defaultIcon;
        if (isSelected) {
          iconToUse = selectedIcon;
        } else if (isViaStationForFilteredRoutes) {
          iconToUse = viaIcon;
        }

        // Create grouped icon for cities with multiple stations
        if (filteredStop.isGrouped) {
          // Use orange gradient when selected, blue when not selected
          const bgGradient = isSelected
            ? "linear-gradient(135deg, #FF9800, #F57C00)"
            : "linear-gradient(135deg, #2196F3, #1976D2)";

          const groupIcon = new Leaflet.DivIcon({
            className: isSelected
              ? "grouped-station-dot selected"
              : "grouped-station-dot",
            html: `<div style="width: 20px; height: 20px; background: ${bgGradient}; border-radius: 50%; border: 3px solid white; box-shadow: ${isSelected ? "0 3px 8px rgba(255, 152, 0, 0.6)" : "0 3px 8px rgba(33, 150, 243, 0.4)"}, 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000; position: relative;">
              <div style="position: absolute; top: -8px; left: -8px; background: linear-gradient(135deg, #FF9800, #F57C00); color: white; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 6px rgba(255, 152, 0, 0.5); z-index: 2000;">
                ${filteredStop.groupSize}
              </div>
            </div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          iconToUse = groupIcon;
        }

        // Performance optimization: Only render tooltips for selected markers
        // Use stable key without currentZoom to avoid recreating DOM on every zoom
        return (
          <Marker
            key={filteredStop?.stop_id || `marker-${index}`}
            position={[stopLat, stopLon]}
            icon={iconToUse}
            eventHandlers={{
              click: (e) => {
                handleMarkerClick(filteredStop);
              },
            }}
            title={filteredStop.displayName || stop_id}
          >
            {isSelected && (
              <MarkerTooltip
                stationName={filteredStop.displayName || stop_id}
                stationId={stop_id}
                groupedStations={filteredStop.groupedStations}
              />
            )}
          </Marker>
        );
      })
      .filter(Boolean);
  }, [
    filteredStops,
    handleMarkerClick,
    groupCityMarkers,
    stopId,
    cities,
    defaultIcon,
    selectedIcon,
    viaIcon,
    selected,
    stopRouteIds,
    viewMapData,
    normalizeStationName,
    normalizeStationNameForLookup,
  ]);

  // Route colors for visualization (defined outside useMemo to avoid recreation)
  const ROUTE_COLORS = [
    "#FF6B35", // Orange-red
    "#4A90E2", // Blue
    "#50C878", // Green
    "#9B59B6", // Purple
    "#F39C12", // Orange
    "#E74C3C", // Red
    "#3498DB", // Light blue
    "#2ECC71", // Light green
  ];

  // Build route paths (polylines) for selected station
  // This visualizes train routes as lines connecting stations
  // PERFORMANCE OPTIMIZATIONS:
  // - Uses Map for O(1) route lookup instead of O(n) find
  // - Uses Map for O(1) station coordinate lookup instead of O(n) find
  // - Caches normalized station names to avoid repeated calculations
  // - Pre-computes pathOptions to avoid recalculation on each render
  const routePaths = useMemo(() => {
    if (
      !selected ||
      !stopRouteIds ||
      !stopRouteIds.length ||
      !viewMapData ||
      !stops ||
      !stops.length
    ) {
      return [];
    }

    // PERFORMANCE OPTIMIZATION: Create Maps for O(1) lookups
    // Map for fast route lookup by route_id
    const routeMap = new window.Map();
    Object.values(viewMapData).forEach((route) => {
      if (route?.route_id) {
        routeMap.set(route.route_id.toString(), route);
      }
    });

    // Map for fast station coordinate lookup
    // Key: normalized station name, Value: [lat, lon]
    const stationCoordsMap = new window.Map();
    const normalizedNameCache = new window.Map();

    // Helper to get cached normalized name
    const getCachedNormalizedName = (name) => {
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    // Build station coordinates map once
    stops.forEach((stop) => {
      if (!stop.stop_id || !stop.stop_lat || !stop.stop_lon) return;

      const normalizedId = getCachedNormalizedName(stop.stop_id);
      // Store by normalized name
      if (!stationCoordsMap.has(normalizedId)) {
        stationCoordsMap.set(normalizedId, [stop.stop_lat, stop.stop_lon]);
      }
      // Also store by original name for fallback
      if (!stationCoordsMap.has(stop.stop_id)) {
        stationCoordsMap.set(stop.stop_id, [stop.stop_lat, stop.stop_lon]);
      }
    });

    // Helper function to find station coordinates by name (O(1) lookup)
    const findStationCoords = (stationName) => {
      if (!stationName) return null;

      // Try normalized name first
      const normalizedName = getCachedNormalizedName(stationName);
      return (
        stationCoordsMap.get(normalizedName) ||
        stationCoordsMap.get(stationName) ||
        null
      );
    };

    const paths = [];
    // Use stopId in keys to ensure unique keys per station selection
    // This ensures React properly unmounts old polylines when station changes
    const stationKey = stopId || "none";

    // Process each route
    stopRouteIds.forEach((routeId) => {
      // O(1) lookup instead of O(n) find
      const route = routeMap.get(routeId);

      if (!route) return;

      // Helper function to build path for one direction
      const buildPathForDirection = (origin, destination, viaStations) => {
        const stationSequence = [];

        // Add origin
        if (origin) {
          const originCoords = findStationCoords(origin);
          if (originCoords) {
            stationSequence.push(originCoords);
          }
        }

        // Add via stations (if they exist)
        if (viaStations) {
          const viaList = viaStations.split(" - ").filter((s) => s.trim());
          viaList.forEach((viaStation) => {
            const viaCoords = findStationCoords(viaStation.trim());
            if (viaCoords) {
              stationSequence.push(viaCoords);
            }
          });
        }

        // Add destination
        if (destination) {
          const destCoords = findStationCoords(destination);
          if (destCoords) {
            stationSequence.push(destCoords);
          }
        }

        return stationSequence.length >= 2 ? stationSequence : null;
      };

      // Get color for this route (consistent across both directions)
      const routeColor = ROUTE_COLORS[parseInt(routeId) % ROUTE_COLORS.length];
      const pathOptions = {
        color: routeColor,
        weight: 4,
        opacity: 0.8,
        dashArray: "15, 10",
        lineCap: "round",
        lineJoin: "round",
      };

      // Build path for direction 0 (origin_trip_0 -> via_0 -> destination_trip_0)
      const path0 = buildPathForDirection(
        route.origin_trip_0,
        route.destination_trip_0,
        route.via_0,
      );
      if (path0) {
        paths.push({
          positions: path0,
          routeId: routeId,
          key: `route-${stationKey}-${routeId}-0`, // Include stationKey to ensure unique keys per station
          pathOptions: pathOptions,
        });
      }

      // Build path for direction 1 (origin_trip_1 -> via_1 -> destination_trip_1) if exists
      if (route.origin_trip_1 && route.destination_trip_1) {
        const path1 = buildPathForDirection(
          route.origin_trip_1,
          route.destination_trip_1,
          route.via_1,
        );
        if (path1) {
          paths.push({
            positions: path1,
            routeId: routeId,
            key: `route-${stationKey}-${routeId}-1`, // Include stationKey to ensure unique keys per station
            pathOptions: pathOptions, // Same color for reverse direction
          });
        }
      }
    });

    return paths;
  }, [
    selected,
    stopId, // Add stopId to dependencies to ensure recalculation when station changes
    stopRouteIds,
    viewMapData,
    stops,
    normalizeStationNameForLookup,
  ]);

  return (
    <>
      {(isLoading || overallLoading) && (
        <div
          style={{
            position: "absolute",
            zIndex: 1001,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            backgroundColor: "rgba(255,255,255,0.95)",
            padding: "30px 40px",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            textAlign: "center",
            minWidth: "300px",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          <div style={{ marginBottom: "20px" }}>
            <div style={{ fontSize: "48px", marginBottom: "10px" }}>🚂</div>
            <h3
              style={{ margin: "0 0 10px 0", color: "#333", fontSize: "18px" }}
            >
              Loading European Night Trains
            </h3>
            <p
              style={{ margin: "0 0 20px 0", color: "#666", fontSize: "14px" }}
            >
              Discovering 28,000+ stations and 200+ routes across Europe...
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <div
              style={{
                width: "100%",
                height: "8px",
                backgroundColor: "#e0e0e0",
                borderRadius: "4px",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: `${Math.min(loadingProgress, 100)}%`,
                  height: "100%",
                  backgroundColor: "#4CAF50",
                  borderRadius: "4px",
                  transition: "width 0.3s ease",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background:
                      "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
                    animation: "shimmer 1.5s infinite",
                  }}
                />
              </div>
            </div>
            <div
              style={{
                marginTop: "12px",
                fontSize: "14px",
                color: "#333",
                fontWeight: "500",
              }}
            >
              {Math.round(loadingProgress)}% Complete
            </div>
            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                color: "#888",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                {stopsLoading ? "Loading stations..." : "✓ Stations loaded"}
              </span>
              <span>
                {citiesLoading ? "Processing routes..." : "✓ Routes processed"}
              </span>
            </div>
          </div>

          <div style={{ fontSize: "12px", color: "#999" }}>
            {loadingProgress < 50 && "Initializing database connection..."}
            {loadingProgress >= 50 &&
              loadingProgress < 80 &&
              "Loading comprehensive station data..."}
            {loadingProgress >= 80 &&
              loadingProgress < 99 &&
              "Processing route connections..."}
            {loadingProgress >= 99 && "Finalizing map data..."}
          </div>
        </div>
      )}

      {/* Skeleton loading for map */}
      {!isMapInitialized && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#f0f0f0",
            backgroundImage: `
              linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%),
              linear-gradient(45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%),
              linear-gradient(-45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%)
            `,
            backgroundSize: "200% 100%, 20px 20px, 20px 20px",
            backgroundPosition: "-200% 0, 0 0, 0 0",
            animation: "shimmer 2s infinite",
            zIndex: 1,
          }}
        />
      )}

      <MapContainer
        className={mapClassName}
        ref={mapRef}
        zoomControl={false}
        preferCanvas={true}
        {...rest}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Filter
          selected={selected}
          filterName={selectedStationName || stopId}
          onClose={removeFilter}
        />
        <ZoomControl className="outline-none" />
        <LocationControl />
        {/* Render route paths as polylines (only if showRoutes is enabled and station is selected) */}
        {showRoutes &&
          selected &&
          routePaths.length > 0 &&
          routePaths.map((path) => (
            <Polyline
              key={path.key}
              positions={path.positions}
              pathOptions={path.pathOptions}
            />
          ))}
        {markers}
        {children && children({ MapContainer, Marker, TileLayer }, Leaflet)}
      </MapContainer>

      <div ref={sidebarRef}>
        <TrainSidebar
          isOpen={selected}
          sidebarDisabled={sidebarDisabled}
          setSidebarDisabled={setSidebarDisabled}
          stopId={stopId}
          stopRouteIds={stopRouteIds}
          selectedNormalizedName={selectedNormalizedName}
        />
      </div>
    </>
  );
};

export default Map;
