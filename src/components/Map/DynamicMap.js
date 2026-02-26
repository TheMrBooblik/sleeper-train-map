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

const { MapContainer, Marker, TileLayer, Polyline } = ReactLeaflet;
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
import MapClickHandler from "./components/MapClickHandler";
import MapSkeleton from "./components/MapSkeleton";
import {
  NightTrainStationMarkers,
  NightTrainPolylines,
} from "./layers/NightTrainLayer";

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
  const [showTooltips, setShowTooltips] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
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
    njLoadingProgress,
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
    if (selectedNightTrainOverlay) {
      closeTrainDetailPanel();
    } else {
      removeFilter();
    }
  }, [selectedNightTrainOverlay, closeTrainDetailPanel, removeFilter]);

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

  const markers = useMapMarkers({
    filteredStops,
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
    if (overallLoading) {
      setLoadingProgress(stopsLoading ? 15 : 28);
      setLoadingMessage(
        stopsLoading ? "Loading stations..." : "Processing routes...",
      );
    } else {
      setLoadingProgress((p) => Math.max(p, 30));
    }
  }, [overallLoading, stopsLoading, citiesLoading]);

  useEffect(() => {
    if (!overallLoading && nightTrainsReady) {
      setLoadingProgressImmediate(100, "Ready!");
      const t = setTimeout(() => setIsLoading(false), 400);
      return () => clearTimeout(t);
    }
  }, [overallLoading, nightTrainsReady, setLoadingProgressImmediate]);

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

  // Derive overlays in the same render so Back-on-Track, NightJet and EuroNight appear together (no effect-after-paint delay).
  // When a specific night train route is selected (selectedNightTrainOverlay), show only that route and hide the other type entirely.
  const effectiveNjOverlays = useMemo(() => {
    if (selectedNightTrainOverlay) {
      return selectedNightTrainOverlay.type === "nightjet" ? [selectedNightTrainOverlay] : [];
    }
    return selected ? njOverlays : showRoutes ? allNjRoutes : [];
  }, [showRoutes, selected, selectedNightTrainOverlay, allNjRoutes, njOverlays]);
  const effectiveEnOverlays = useMemo(() => {
    if (selectedNightTrainOverlay) {
      return selectedNightTrainOverlay.type === "euronight" ? [selectedNightTrainOverlay] : [];
    }
    return selected ? enOverlays : showRoutes ? allEnRoutes : [];
  }, [showRoutes, selected, selectedNightTrainOverlay, allEnRoutes, enOverlays]);

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

  const showLoading =
    isLoading || overallLoading || !nightTrainsReady;
  const mapClassName = `w-full h-full ${className || ""}`;
  const sidebarRef = useRef(null);

  const filterName = selectedNightTrainOverlay
    ? `${selectedNightTrainOverlay.lineName || "Train"}: ${selectedNightTrainOverlay.stations?.[0]?.name || "?"} → ${selectedNightTrainOverlay.stations?.[selectedNightTrainOverlay.stations?.length - 1]?.name || "?"}`
    : selectedStationName || stopId;

  return (
    <>
      {showLoading && (
        <LoadingOverlay
          loadingProgress={loadingProgress}
          loadingMessage={loadingMessage}
          stopsLoading={stopsLoading}
          citiesLoading={citiesLoading}
          njLoadingProgress={njLoadingProgress}
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
          hasSelection={selected || !!selectedNightTrainOverlay}
          onClearFilter={handleFilterClose}
        />
        <Filter
          selected={selected || !!selectedNightTrainOverlay}
          filterName={filterName}
          onClose={handleFilterClose}
        />
        <ZoomControl className="outline-none" />
        <LocationControl />

        {!selectedNightTrainOverlay && (
          <NightTrainStationMarkers
            stations={selected ? filteredNjStations : allNjStations}
            endpointStations={nightTrainEndpointStations}
            hideIntermediateStations={hideIntermediateStations}
            stationKeyPrefix="nj-all-station"
            markerClassName="nj-station-marker"
            stops={stops}
            matchStationNames={matchStationNamesBound}
            onMarkerClick={handleMarkerClick}
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
        />

        {!selectedNightTrainOverlay && (
          <NightTrainStationMarkers
            stations={selected ? filteredEnStations : allEnStations}
            endpointStations={nightTrainEndpointStations}
            hideIntermediateStations={hideIntermediateStations}
            stationKeyPrefix="en-all-station"
            markerClassName="en-station-marker"
            stops={stops}
            matchStationNames={matchStationNamesBound}
            onMarkerClick={handleMarkerClick}
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
        />

        {!selectedNightTrainOverlay && routePaths.length > 0 &&
          routePaths.map((path) => (
            <Polyline
              key={path.key}
              positions={path.positions}
              pathOptions={{ ...path.pathOptions, cursor: "pointer" }}
              eventHandlers={{
                click: (e) => {
                  e.originalEvent.stopPropagation();
                  handlePolylineClick(path.routeId);
                },
              }}
            />
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
    </>
  );
};

export default TrainMap;
