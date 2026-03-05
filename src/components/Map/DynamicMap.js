"use client";

import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
  startTransition,
} from "react";
import Leaflet from "leaflet";
import * as ReactLeaflet from "react-leaflet";

const { MapContainer, Marker, TileLayer, Polyline, Tooltip } = ReactLeaflet;
import "leaflet/dist/leaflet.css";

import Filter from "src/components/Filter";
import { useStops } from "../../hooks/requests/useStops";
import { useCities } from "../../hooks/requests/useCities";
import { normalizeStationNameForLookup } from "../../hooks/requests/useCities";
import { useViewMap } from "../../hooks/requests/useViewMap";
import { useTrips } from "../../hooks/requests/useTrips";
import TrainBottomBar from "@components/TrainBottomBar";
import TrainDetailPanel from "@components/TrainDetailPanel";
import ZoomControl from "@components/ZoomControl";
import LocationControl from "@components/LocationControl";
import { stationsToSkip } from "../../data/stationsToSkip";

import { normalizeStationNameForDisplay, matchStationNames } from "./utils/stationNameUtils";
import { shouldHideRouteDueToFutureDate } from "./utils/routeStyleUtils";
import { useNightTrainData } from "./hooks/useNightTrainData";
import { useRoutePaths } from "./hooks/useRoutePaths";
import { useMapMarkers } from "./hooks/useMapMarkers";
import LoadingOverlay from "./components/LoadingOverlay";
import BackgroundLoadingBadge from "./components/BackgroundLoadingBadge";
import MapClickHandler from "./components/MapClickHandler";
import MapSkeleton from "./components/MapSkeleton";
import {
  NightTrainStationMarkers,
  NightTrainPolylines,
} from "./layers/NightTrainLayer";

/** Format "YYYY-MM-DD" → "15 January 2026" for the future-route popup. */
function formatFutureDate(dateStr) {
  if (!dateStr) return "TBD";
  try {
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

const TrainMap = ({
  children,
  className,
  isGrouped,
  showRoutes = true,
  hideIntermediateStations = false,
  ...rest
}) => {
  const [sidebarDisabled, setSidebarDisabled] = useState(false);
  const {
    stops,
    filteredStops,
    setFilteredStops,
    isLoading: stopsLoading,
  } = useStops();
  const { cities, isLoading: citiesLoading } = useCities();
  const { viewMapData } = useViewMap();
  const { trips } = useTrips();

  const [selected, setSelected] = useState(false);
  const [stopId, setStopId] = useState();
  const [isMapInitialized, setIsMapInitialized] = useState(false);
  // Info for a clicked future-route line: { routeId, futureStartDate }
  const [futureRouteInfo, setFutureRouteInfo] = useState(null);
  const [showTooltips, setShowTooltips] = useState(false);
  // isLoading removed — map is shown as soon as GTFS (stops+cities) finish
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("Starting...");
  const [stopRouteIds, setStopRouteIds] = useState();
  const [selectedStationName, setSelectedStationName] = useState("");
  const [selectedNormalizedName, setSelectedNormalizedName] = useState("");
  const [selectedStationLat, setSelectedStationLat] = useState(null);
  const [selectedStationLon, setSelectedStationLon] = useState(null);
  const [selectedTrainRouteIds, setSelectedTrainRouteIds] = useState([]);
  const [isTrainDetailPanelOpen, setIsTrainDetailPanelOpen] = useState(false);
  const [selectedNightTrainOverlay, setSelectedNightTrainOverlay] = useState(null);

  const loadingProgressRef = useRef({ progress: 0, message: "" });
  const loadingThrottleRef = useRef(null);
  const setLoadingProgressThrottled = useCallback((progress, message) => {
    loadingProgressRef.current = {
      progress: progress ?? loadingProgressRef.current.progress,
      message: message ?? loadingProgressRef.current.message,
    };
    if (loadingThrottleRef.current !== null) return;
    loadingThrottleRef.current = requestAnimationFrame(() => {
      loadingThrottleRef.current = null;
      setLoadingProgress(loadingProgressRef.current.progress);
      if (loadingProgressRef.current.message) {
        setLoadingMessage(loadingProgressRef.current.message);
      }
    });
  }, []);
  const setLoadingProgressImmediate = useCallback((progress, message) => {
    if (loadingThrottleRef.current !== null) {
      cancelAnimationFrame(loadingThrottleRef.current);
      loadingThrottleRef.current = null;
    }
    setLoadingProgress(progress);
    if (message != null) setLoadingMessage(message);
  }, []);

  const nightTrain = useNightTrainData({
    setLoadingProgressImmediate,
    setIsMapInitialized,
    setShowTooltips,
    normalizeStationNameForLookup,
    setFilteredStops,
    stops,
  });

  const {
    njOverlays,
    setNjOverlays,
    enOverlays,
    setEnOverlays,
    allNjStations,
    allEnStations,
    filteredNjStations,
    setFilteredNjStations,
    filteredEnStations,
    setFilteredEnStations,
    allNjRoutes,
    setAllNjRoutes,
    allEnRoutes,
    setAllEnRoutes,
    nightTrainsReady,
    loadNightTrainsForStation,
  } = nightTrain;

  const { routePaths } = useRoutePaths({
    viewMapData,
    stops,
    cities,
    trips,
    selected,
    stopId,
    stopRouteIds,
    selectedTrainRouteIds,
    showRoutes,
    stationsToSkip,
    normalizeStationNameForLookup,
  });

  const removeFilter = useCallback(() => {
    setNjOverlays([]);
    setEnOverlays([]);
    setFilteredNjStations([]);
    setFilteredEnStations([]);
    setStopId(null);
    setSelected(false);
    setSelectedStationName("");
    setSelectedNormalizedName("");
    setSelectedStationLat(null);
    setSelectedStationLon(null);
    setStopRouteIds([]);
    setFilteredStops(stops);
  }, [
    setNjOverlays,
    setEnOverlays,
    setFilteredNjStations,
    setFilteredEnStations,
    setFilteredStops,
    stops,
  ]);

  const handlePolylineClick = useCallback((routeIds) => {
    const idsArray = Array.isArray(routeIds) ? routeIds : [routeIds];
    startTransition(() => {
      setSelectedNightTrainOverlay(null);
      setSelectedTrainRouteIds(idsArray);
      setIsTrainDetailPanelOpen(true);
    });
  }, []);

  const handleNightTrainPolylineClick = useCallback((overlay) => {
    startTransition(() => {
      setSelectedTrainRouteIds([]);
      setSelectedNightTrainOverlay(overlay);
      setIsTrainDetailPanelOpen(true);
    });
  }, []);

  const closeTrainDetailPanel = useCallback(() => {
    setIsTrainDetailPanelOpen(false);
    setSelectedTrainRouteIds([]);
    setSelectedNightTrainOverlay(null);
  }, []);

  const handleFilterClose = useCallback(() => {
    // Always clear any open future-route popup too
    setFutureRouteInfo(null);
    if (selectedNightTrainOverlay) {
      closeTrainDetailPanel();
    } else if (selectedTrainRouteIds?.length > 0) {
      // Back-on-Track route filter: close panel and clear route selection (same as NightJet).
      closeTrainDetailPanel();
    } else {
      removeFilter();
    }
  }, [selectedNightTrainOverlay, selectedTrainRouteIds, closeTrainDetailPanel, removeFilter]);

  const matchStationNamesBound = useCallback(
    (a, b) => matchStationNames(a, b, normalizeStationNameForLookup),
    [normalizeStationNameForLookup],
  );

  const handleMarkerClick = useCallback(
    (filteredStop) => {
      const { stop_id } = filteredStop;
      // Close filter only when user clicks the *same logical station* again.
      // Compare against the previously selected stopId using the name matcher.
      // This avoids accidentally closing when the user clicks a different station
      // in the same city (e.g. another Brussels-area stop).
      if (selected && stopId && matchStationNamesBound(stop_id, stopId)) {
        removeFilter();
        return;
      }

      // New station selected: update filter + routes for this station.
      setStopId(stop_id);
      setSelectedStationLat(filteredStop.stop_lat);
      setSelectedStationLon(filteredStop.stop_lon);
      const normalizedStopId = normalizeStationNameForLookup(stop_id);
      const cityInfo = cities[normalizedStopId] || cities[stop_id];
      const filterName = normalizeStationNameForDisplay(stop_id);
      setSelectedStationName(filterName);
      setSelectedNormalizedName(normalizeStationNameForDisplay(stop_id));

      if (cityInfo?.stop_route_ids) {
        const { stop_route_ids } = cityInfo;
        let routeIdsArray;
        if (filteredStop.isGrouped && filteredStop.groupedStations) {
          const allRouteIds = new Set();
          filteredStop.groupedStations.forEach((station) => {
            const n = normalizeStationNameForLookup(station.stop_id);
            const info = cities[n] || cities[station.stop_id];
            if (info?.stop_route_ids) {
              info.stop_route_ids.split(",").forEach((id) => allRouteIds.add(id));
            }
          });
          routeIdsArray = Array.from(allRouteIds);
        } else {
          routeIdsArray = Array.from(
            new Set(stop_route_ids.split(",").filter(Boolean)),
          );
        }
        setStopRouteIds(routeIdsArray);

        const routeCities = Object.values(cities).filter((viewCity) => {
          if (!viewCity?.stop_route_ids) return false;
          const arr = viewCity.stop_route_ids.split(",");
          return arr.some((id) => routeIdsArray.includes(id));
        });
        const stopsMap = new Map();
        stops.forEach((stop) => {
          if (!stop.stop_id) return;
          const n = normalizeStationNameForLookup(stop.stop_id);
          if (!stopsMap.has(n)) stopsMap.set(n, stop);
          if (!stopsMap.has(stop.stop_id)) stopsMap.set(stop.stop_id, stop);
        });
        const routeStops = routeCities
          .map((city) => stopsMap.get(city.stop_id))
          .filter(Boolean);
        setFilteredStops(routeStops);
      } else {
        setStopRouteIds([]);
        setFilteredStops([]);
      }

      setSelected(true);
      if (filterName) {
        queueMicrotask(() => loadNightTrainsForStation(filterName, stop_id));
      }
    },
    [
      cities,
      stops,
      setFilteredStops,
      stopId,
      selected,
      removeFilter,
      matchStationNamesBound,
      normalizeStationNameForLookup,
      normalizeStationNameForDisplay,
      loadNightTrainsForStation,
    ],
  );

  // Back-on-Track route filter (same UX as NightJet: one route on map, filter bar, and only this route's stations).
  const hasRouteFilter = selectedTrainRouteIds?.length > 0;

  // Derive the set of stations that belong to the currently selected Back-on-Track route.
  // We re-use the same origin/destination/via fields as route polylines and map them to GTFS stops.
  const routeFilterStops = useMemo(() => {
    if (!hasRouteFilter || !viewMapData || !stops?.length) return null;
    const activeId = String(selectedTrainRouteIds[0]);
    const route = Object.values(viewMapData).find(
      (r) => r?.route_id?.toString() === activeId,
    );
    if (!route) return null;

    const stationNames = new Set();
    const addDirection = (origin, destination, via) => {
      if (origin) stationNames.add(origin);
      if (destination) stationNames.add(destination);
      if (via) {
        via
          .split(" - ")
          .map((s) => s.trim())
          .forEach((name) => {
            if (name) stationNames.add(name);
          });
      }
    };

    addDirection(route.origin_trip_0, route.destination_trip_0, route.via_0);
    addDirection(route.origin_trip_1, route.destination_trip_1, route.via_1);

    if (stationNames.size === 0) return null;

    const normalizedNameCache = new Map();
    const getNormalized = (name) => {
      if (!name) return null;
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    const stopLookup = new Map();
    stops.forEach((stop) => {
      if (!stop.stop_id) return;
      const n = getNormalized(stop.stop_id);
      if (n && !stopLookup.has(n)) stopLookup.set(n, stop);
      if (!stopLookup.has(stop.stop_id)) stopLookup.set(stop.stop_id, stop);
    });

    const result = [];
    stationNames.forEach((name) => {
      const n = getNormalized(name);
      const match = (n && stopLookup.get(n)) || stopLookup.get(name);
      if (match) result.push(match);
    });

    return result.length > 0 ? result : null;
  }, [hasRouteFilter, selectedTrainRouteIds, viewMapData, stops, normalizeStationNameForLookup]);

  const markers = useMapMarkers({
    filteredStops: routeFilterStops || filteredStops,
    stops,
    cities,
    viewMapData,
    selected,
    stopId,
    stopRouteIds,
    isGrouped,
    hideIntermediateStations,
    stationsToSkip,
    normalizeStationNameForLookup,
    normalizeStationNameForDisplay,
    handleMarkerClick,
    trips,
  });

  const overallLoading = stopsLoading || citiesLoading;

  useEffect(() => {
    // Keep progress tracking for the background badge (used by useNightTrainData callbacks).
    // During GTFS loading phase: set early progress markers.
    if (overallLoading) {
      setLoadingProgress(stopsLoading ? 15 : 28);
      setLoadingMessage(
        stopsLoading ? "Loading stations..." : "Processing routes...",
      );
    } else {
      setLoadingProgress((p) => Math.max(p, 30));
    }
  }, [overallLoading, stopsLoading, citiesLoading]);

  // As soon as GTFS data is ready, reveal the map — no need to wait for night trains.
  // Night trains will render on top once their async load finishes.
  useEffect(() => {
    if (!overallLoading) {
      setIsMapInitialized(true);
      setShowTooltips(true);
    }
  }, [overallLoading]);

  useEffect(() => {
    if (selected) return;
    if (showRoutes) {
      setNjOverlays(allNjRoutes);
      setEnOverlays(allEnRoutes);
    } else {
      setNjOverlays([]);
      setEnOverlays([]);
    }
  }, [showRoutes, selected, allNjRoutes, allEnRoutes, setNjOverlays, setEnOverlays]);

  const hasSelection = selected || !!selectedNightTrainOverlay || hasRouteFilter;

  // When a specific night train route is selected, show only that route; when a Back-on-Track route is selected, hide night trains.
  const effectiveNjOverlays = useMemo(() => {
    if (hasRouteFilter) return [];
    if (selectedNightTrainOverlay) {
      return selectedNightTrainOverlay.type === "nightjet" ? [selectedNightTrainOverlay] : [];
    }
    return selected ? njOverlays : showRoutes ? allNjRoutes : [];
  }, [showRoutes, selected, selectedNightTrainOverlay, hasRouteFilter, allNjRoutes, njOverlays]);
  const effectiveEnOverlays = useMemo(() => {
    if (hasRouteFilter) return [];
    if (selectedNightTrainOverlay) {
      return selectedNightTrainOverlay.type === "euronight" ? [selectedNightTrainOverlay] : [];
    }
    return selected ? enOverlays : showRoutes ? allEnRoutes : [];
  }, [showRoutes, selected, selectedNightTrainOverlay, hasRouteFilter, allEnRoutes, enOverlays]);

  useEffect(() => {
    if (!stops?.length || !cities || overallLoading) return;
    setFilteredStops(stops);
  }, [stops, cities, setFilteredStops, overallLoading]);

  const nightTrainEndpointStations = useMemo(() => {
    const endpointSet = new Set();
    [...allNjRoutes, ...allEnRoutes].forEach((route) => {
      if (!route.stations?.length) return;
      const first = route.stations[0];
      const last = route.stations[route.stations.length - 1];
      if (first?.name) endpointSet.add(first.name);
      if (first?.id) endpointSet.add(first.id);
      if (last?.name) endpointSet.add(last.name);
      if (last?.id) endpointSet.add(last.id);
    });
    return endpointSet;
  }, [allNjRoutes, allEnRoutes]);

  // NightJet/EuroNight routes that pass through the selected station (for sidebar)
  const nightTrainRoutesForSidebar = useMemo(() => {
    if (!selected || (!stopId && !selectedStationName)) return [];
    const nameA = selectedStationName || stopId;
    const nameB = stopId || selectedStationName;
    const matches = (stationName) =>
      matchStationNamesBound(stationName, nameA) ||
      (nameB && nameB !== nameA && matchStationNamesBound(stationName, nameB));
    const out = [];
    njOverlays.forEach((ov) => {
      if (!ov.stations?.length) return;
      const passes = ov.stations.some((s) => matches(s?.name));
      if (passes)
        out.push({
          type: "nightjet",
          lineName: ov.lineName,
          origin: ov.stations[0]?.name,
          destination: ov.stations[ov.stations.length - 1]?.name,
          color: ov.color,
          source: ov.source,
        });
    });
    enOverlays.forEach((ov) => {
      if (!ov.stations?.length) return;
      const passes = ov.stations.some((s) => matches(s?.name));
      if (passes)
        out.push({
          type: "euronight",
          lineName: ov.lineName,
          origin: ov.stations[0]?.name,
          destination: ov.stations[ov.stations.length - 1]?.name,
          color: ov.color,
          source: ov.source,
        });
    });
    return out;
  }, [
    selected,
    stopId,
    selectedStationName,
    njOverlays,
    enOverlays,
    matchStationNamesBound,
  ]);

  const escFunction = useCallback(
    (event) => {
      if (event.key === "Escape") handleFilterClose();
    },
    [handleFilterClose],
  );
  useEffect(() => {
    document.addEventListener("keydown", escFunction, false);
    return () => document.removeEventListener("keydown", escFunction, false);
  }, [escFunction]);

  // Only block the map on GTFS loading (fast, ~1-2s).
  // Night trains load in the background; badge shows their progress.
  const showLoading = overallLoading;
  const mapClassName = `w-full h-full ${className || ""}`;
  const sidebarRef = useRef(null);

  const filterName = selectedNightTrainOverlay
    ? `${selectedNightTrainOverlay.lineName || "Train"}: ${selectedNightTrainOverlay.stations?.[0]?.name || "?"} → ${selectedNightTrainOverlay.stations?.[selectedNightTrainOverlay.stations?.length - 1]?.name || "?"}`
    : hasRouteFilter
      ? (() => {
          const route = viewMapData
            ? Object.values(viewMapData).find(
                (r) => r?.route_id?.toString() === String(selectedTrainRouteIds[0]),
              )
            : null;
          if (!route) return "Route";
          const trainNumber =
            route.trip_short_name_0 || route.trip_short_name_1 || null;
          const segment = `${route.origin_trip_0 || "?"} → ${route.destination_trip_0 || "?"}`;
          return trainNumber ? `${trainNumber}: ${segment}` : `Route: ${segment}`;
        })()
      : selectedStationName || stopId;

  return (
    <>
      {/* Initial fast overlay: only blocks while GTFS (stations/routes) load (~1-2s) */}
      {showLoading && (
        <LoadingOverlay
          stopsLoading={stopsLoading}
          citiesLoading={citiesLoading}
        />
      )}

      {/* Non-blocking corner badge: shows NightJet/EuroNight loading progress in background */}
      {!overallLoading && (
        <BackgroundLoadingBadge
          nightTrainsReady={nightTrainsReady}
          loadingProgress={loadingProgress}
          loadingMessage={loadingMessage}
        />
      )}

      {!isMapInitialized && <MapSkeleton />}

      <MapContainer
        className={mapClassName}
        zoomControl={false}
        preferCanvas={true}
        {...rest}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <MapClickHandler
          hasSelection={hasSelection}
          onClearFilter={handleFilterClose}
        />
        <Filter
          selected={hasSelection}
          filterName={filterName}
          onClose={handleFilterClose}
        />
        <ZoomControl className="outline-none" />
        <LocationControl />

        {/* When a Back-on-Track route is selected (e.g. European Sleeper), hide all NightJet/EuroNight stations so only that route's stations show. */}
        {!selectedNightTrainOverlay && !hasRouteFilter && (
          <NightTrainStationMarkers
            stations={selected ? filteredNjStations : allNjStations}
            endpointStations={nightTrainEndpointStations}
            hideIntermediateStations={hideIntermediateStations}
            stationKeyPrefix="nj-all-station"
            markerClassName="nj-station-marker"
            stops={stops}
            matchStationNames={matchStationNamesBound}
            onMarkerClick={handleMarkerClick}
            selected={selected}
            stopId={stopId}
          />
        )}
        <NightTrainPolylines
          overlays={effectiveNjOverlays}
          selectedOverlay={selectedNightTrainOverlay}
          overlayType="nightjet"
          onPolylineClick={handleNightTrainPolylineClick}
          onRouteStationClick={handleMarkerClick}
          stops={stops}
          matchStationNames={matchStationNamesBound}
          hideIntermediateStations={hideIntermediateStations}
          stationKeyPrefix="nj-station"
          markerClassName="nightjet-station-dot"
          selected={selected}
          stopId={stopId}
        />

        {!selectedNightTrainOverlay && !hasRouteFilter && (
          <NightTrainStationMarkers
            stations={selected ? filteredEnStations : allEnStations}
            endpointStations={nightTrainEndpointStations}
            hideIntermediateStations={hideIntermediateStations}
            stationKeyPrefix="en-all-station"
            markerClassName="en-station-marker"
            stops={stops}
            matchStationNames={matchStationNamesBound}
            onMarkerClick={handleMarkerClick}
            selected={selected}
            stopId={stopId}
          />
        )}
        <NightTrainPolylines
          overlays={effectiveEnOverlays}
          selectedOverlay={selectedNightTrainOverlay}
          overlayType="euronight"
          onPolylineClick={handleNightTrainPolylineClick}
          onRouteStationClick={handleMarkerClick}
          stops={stops}
          matchStationNames={matchStationNamesBound}
          hideIntermediateStations={hideIntermediateStations}
          stationKeyPrefix="en-station"
          markerClassName="euronight-station-dot"
          selected={selected}
          stopId={stopId}
        />

        {!selectedNightTrainOverlay &&
          routePaths.length > 0 &&
          routePaths.map((path) => (
            <Polyline
              key={path.key}
              positions={path.positions}
              pathOptions={{ ...path.pathOptions, cursor: "pointer" }}
              eventHandlers={{
                click: (e) => {
                  e.originalEvent.stopPropagation();
                  if (path.isFuture) {
                    // Future route: show info popup instead of detail panel
                    setFutureRouteInfo({
                      routeId: path.routeId,
                      futureStartDate: path.futureStartDate,
                    });
                  } else {
                    setFutureRouteInfo(null);
                    handlePolylineClick(path.routeId);
                  }
                },
              }}
            >
              <Tooltip sticky>
                {(() => {
                  const route = viewMapData
                    ? Object.values(viewMapData).find(
                        (r) =>
                          r?.route_id &&
                          r.route_id.toString() === String(path.routeId),
                      )
                    : null;
                  if (!route) return `Route ${path.routeId}`;

                  const isDirectionOne = path.key.endsWith("-1");
                  const origin = isDirectionOne
                    ? route.origin_trip_1 || route.origin_trip_0
                    : route.origin_trip_0 || route.origin_trip_1;
                  const destination = isDirectionOne
                    ? route.destination_trip_1 || route.destination_trip_0
                    : route.destination_trip_0 || route.destination_trip_1;
                  const trainNumber = isDirectionOne
                    ? route.trip_short_name_1 || route.trip_short_name_0
                    : route.trip_short_name_0 || route.trip_short_name_1;

                  const segment = `${origin || "?"} → ${destination || "?"}`;
                  const label = trainNumber
                    ? `${trainNumber}: ${segment}`
                    : `Route: ${segment}`;
                  // Hint for future routes directly in the tooltip
                  return path.isFuture
                    ? `${label} · opens ${formatFutureDate(path.futureStartDate)}`
                    : label;
                })()}
              </Tooltip>
            </Polyline>
          ))}
        {!selectedNightTrainOverlay && markers}
        {children && children({ MapContainer, Marker, TileLayer }, Leaflet)}
      </MapContainer>

      <div ref={sidebarRef}>
        <TrainBottomBar
          isOpen={selected}
          sidebarDisabled={sidebarDisabled}
          setSidebarDisabled={setSidebarDisabled}
          stopId={stopId}
          stopRouteIds={stopRouteIds}
          selectedNormalizedName={selectedNormalizedName}
          nightTrainRoutes={nightTrainRoutesForSidebar}
          isDetailPanelOpen={isTrainDetailPanelOpen}
        />
      </div>

      <TrainDetailPanel
        isOpen={isTrainDetailPanelOpen}
        onClose={closeTrainDetailPanel}
        selectedRouteIds={
          selectedTrainRouteIds?.filter(
            (id) => !shouldHideRouteDueToFutureDate(id, trips),
          ) ?? []
        }
        nightTrainOverlay={selectedNightTrainOverlay}
      />

      {/* Future-route info popup — appears when user clicks a ghost line */}
      {futureRouteInfo && (() => {
        const route = viewMapData
          ? Object.values(viewMapData).find(
              (r) => r?.route_id?.toString() === String(futureRouteInfo.routeId),
            )
          : null;
        const trainNumber = route?.trip_short_name_0 || route?.trip_short_name_1 || `Route ${futureRouteInfo.routeId}`;
        const origin = route?.origin_trip_0 || route?.origin_trip_1 || "?";
        const destination = route?.destination_trip_0 || route?.destination_trip_1 || "?";
        return (
          <div
            style={{
              position: "absolute",
              bottom: "50px",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 1000,
              backgroundColor: "rgba(255,255,255,0.97)",
              borderRadius: "10px",
              boxShadow: "0 2px 16px rgba(0,0,0,0.18)",
              padding: "12px 16px",
              border: "1px solid #e2e8f0",
              display: "flex",
              alignItems: "center",
              gap: "12px",
              maxWidth: "340px",
              minWidth: "240px",
              pointerEvents: "auto",
            }}
          >
            <span style={{ fontSize: "22px", flexShrink: 0 }}>🗓️</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b", marginBottom: "2px" }}>
                {trainNumber}: {origin} → {destination}
              </div>
              <div style={{ fontSize: "12px", color: "#64748b" }}>
                Future route · opens {formatFutureDate(futureRouteInfo.futureStartDate)}
              </div>
            </div>
            <button
              onClick={() => setFutureRouteInfo(null)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#94a3b8",
                fontSize: "18px",
                lineHeight: 1,
                padding: "2px 4px",
                flexShrink: 0,
              }}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        );
      })()}
    </>
  );
};

export default TrainMap;
