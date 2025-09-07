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

const Map = ({ children, className, ...rest }) => {
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
  const mapRef = useRef();
  const sidebarRef = useRef(null);

  const mapClassName = className ? `${styles.map} ${className}` : styles.map;

  const removeFilter = () => {
    setStopId(null);
    setSelected(false);
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
    [cities, stops, setFilteredStops, stopId, selected, removeFilter],
  );

  const markers = useMemo(() => {
    if (!filteredStops || !filteredStops.length) return [];

    // Show all markers without filtering, but limit tooltip rendering
    const markersToRender = filteredStops;

    return markersToRender
      .map((filteredStop, index) => {
        const isSelected = stopId === filteredStop?.stop_id;
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

        // Optimize marker rendering based on importance/selection
        // Only render tooltips for selected markers to improve performance
        return (
          <Marker
            key={`${filteredStop?.stop_id || index}`}
            position={[stopLat, stopLon]}
            icon={iconToUse}
            eventHandlers={{
              click: (e) => {
                handleMarkerClick(filteredStop);
              },
            }}
            title={stop_id}
          >
            {isSelected && (
              <MarkerTooltip stationName={stop_id} stationId={stop_id} />
            )}
          </Marker>
        );
      })
      .filter(Boolean);
  }, [filteredStops, handleMarkerClick]);

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
          filterName={stopId}
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
