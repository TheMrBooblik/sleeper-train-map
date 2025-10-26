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

const { MapContainer, Marker, TileLayer, Tooltip } = ReactLeaflet;
import "leaflet/dist/leaflet.css";

import styles from "./Map.module.scss";
import Filter from "src/components/Filter";
import MarkerTooltip from "@components/MarkerTooltip";
import { useStops } from "../../hooks/requests/useStops";
import { useCities } from "../../hooks/requests/useCities";
import TrainSidebar from "@components/TrainSidebar";
import ZoomControl from "@components/ZoomControl";
import LocationControl from "@components/LocationControl";

const Map = ({ children, className, isGrouped, setIsGrouped, ...rest }) => {
  const [sidebarDisabled, setSidebarDisabled] = useState(false);
  const {
    stops,
    filteredStops,
    setFilteredStops,
    isLoading: stopsLoading,
  } = useStops();
  const { cities, isLoading: citiesLoading, refreshCities } = useCities();
  const [selected, setSelected] = useState(false);
  const [stopId, setStopId] = useState();
  const [isMapInitialized, setIsMapInitialized] = useState(false);
  const [showTooltips, setShowTooltips] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [stopRouteIds, setStopRouteIds] = useState();
  const [currentZoom, setCurrentZoom] = useState(5);
  const [selectedStationName, setSelectedStationName] = useState("");
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
    else if (stationName.includes("Wien") || stationName.includes("Vienna")) {
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
      const cityInfo = cities[stop_id];

      if (!cityInfo || !cityInfo.stop_route_ids) return;

      // Set station name based on grouping state
      const filterName = isGrouped ? normalizeStationName(stop_id) : stop_id;
      setSelectedStationName(filterName);

      const { stop_route_ids } = cityInfo;

      const routeIdsArray = stop_route_ids.split(",").filter((el) => el);
      setStopRouteIds(routeIdsArray);

      const routeCities = Object.values(cities).filter((viewCity) => {
        if (!viewCity || !viewCity.stop_route_ids) return false;
        const arr = viewCity.stop_route_ids.split(",");
        return arr.some((item) => routeIdsArray.includes(item));
      });

      const routeStops = routeCities
        .map((el) => stops.find((stop) => stop.stop_id === el.stop_id))
        .filter(Boolean);

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

        const cityInfo = cities[stop.stop_id];
        if (!cityInfo?.stop_route_ids) return;

        // Use the normalizeStationName function
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
              const cityInfo = cities[station.stop_id];
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
        const cityInfo = cities[stop_id];
        const { stop_route_ids, isViaStation } = cityInfo || {};

        if (!stopLat || !stopLon || !stop_route_ids || !cityInfo) return null;

        // Choose the appropriate icon based on station type and selection
        let iconToUse = defaultIcon;
        if (isSelected) {
          iconToUse = selectedIcon;
        } else if (isViaStation) {
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
              <div style="position: absolute; top: -8px; right: -8px; background: linear-gradient(135deg, #FF9800, #F57C00); color: white; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 6px rgba(255, 152, 0, 0.5); z-index: 2000;">
                ${filteredStop.groupSize}
              </div>
            </div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          iconToUse = groupIcon;
        }

        // Performance optimization: Only render tooltips for selected markers
        return (
          <Marker
            key={`${filteredStop?.stop_id || index}-${currentZoom}`}
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
    currentZoom,
    stopId,
    cities,
    defaultIcon,
    selectedIcon,
    viaIcon,
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
        />
      </div>
    </>
  );
};

export default Map;
