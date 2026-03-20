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
import { useInitialData } from "../../hooks/requests/useInitialData";
import { normalizeStationNameForLookup } from "../../hooks/requests/useCities";
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
import { groupCityMarkers } from "./utils/groupCityMarkers";
import LoadingOverlay from "./components/LoadingOverlay";
import BackgroundLoadingBadge from "./components/BackgroundLoadingBadge";
import MapClickHandler from "./components/MapClickHandler";
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
    cities,
    viewMapData,
    trips,
    isLoading: initialDataLoading,
  } = useInitialData();

  const [selected, setSelected] = useState(false);
  const [stopId, setStopId] = useState();
  const [isMapInitialized, setIsMapInitialized] = useState(false);
  const [showTooltips, setShowTooltips] = useState(false);
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

  const setLoadingProgressImmediate = useCallback((progress, message) => {
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

  // Client-side filtering: remove NJ/EN routes from viewMapData and trips once
  // official NightJet/EuroNight data has loaded. Before that, NJ/EN render as
  // regular Back-on-Track routes so their stations appear with consistent styling.
  const hasNightTrainOverlays = (allNjRoutes?.length ?? 0) > 0 || (allEnRoutes?.length ?? 0) > 0;
  const effectiveViewMapData = useMemo(() => {
    // Avoid stations "disappearing" during loading by only filtering once
    // we actually have night overlay routes to display.
    if (!viewMapData || !nightTrainsReady || !hasNightTrainOverlays) return viewMapData;
    const filtered = {};
    Object.entries(viewMapData).forEach(([key, route]) => {
      const t0 = (route?.trip_short_name_0 || "").toString();
      const t1 = (route?.trip_short_name_1 || "").toString();
      if (/^\s*NJ\s+\d+/.test(t0) || /^\s*NJ\s+\d+/.test(t1)) return;
      if (/^\s*EN\s+\d+/.test(t0) || /^\s*EN\s+\d+/.test(t1)) return;
      filtered[key] = route;
    });
    return filtered;
  }, [viewMapData, nightTrainsReady, hasNightTrainOverlays]);

  const effectiveTrips = useMemo(() => {
    if (!trips || !nightTrainsReady || !hasNightTrainOverlays) return trips;
    const filtered = {};
    Object.entries(trips).forEach(([key, trip]) => {
      const name = (trip?.trip_short_name || trip?.route_short_name || "").toString();
      if (/^\s*NJ\s+\d+/.test(name) || /^\s*EN\s+\d+/.test(name)) return;
      filtered[key] = trip;
    });
    return filtered;
  }, [trips, nightTrainsReady, hasNightTrainOverlays]);

  // When official NightJet/EuroNight data is loaded, filter cities to only keep
  // route IDs present in effectiveViewMapData. Stations that ONLY had NJ/EN routes
  // will have no remaining route IDs and won't render as Back-on-Track markers
  // (the NightTrain layer already shows them with proper styling).
  const effectiveCities = useMemo(() => {
    if (!nightTrainsReady || !hasNightTrainOverlays || !cities || !effectiveViewMapData) return cities;
    const validRouteIds = new Set();
    Object.values(effectiveViewMapData).forEach((route) => {
      if (route?.route_id) validRouteIds.add(route.route_id.toString());
    });
    const filtered = {};
    Object.entries(cities).forEach(([key, city]) => {
      if (!city?.stop_route_ids) return;
      const kept = city.stop_route_ids
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id && validRouteIds.has(id));
      if (kept.length > 0) {
        filtered[key] = { ...city, stop_route_ids: kept.join(",") };
      }
    });
    return filtered;
  }, [nightTrainsReady, hasNightTrainOverlays, cities, effectiveViewMapData]);

  const { routePaths } = useRoutePaths({
    viewMapData: effectiveViewMapData,
    stops,
    cities: effectiveCities,
    trips: effectiveTrips,
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
    if (selectedNightTrainOverlay) {
      closeTrainDetailPanel();
    } else if (selectedTrainRouteIds?.length > 0) {
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
      // Direct key lookup first; fallback to fuzzy match when NightTrain names
      // differ from Back-on-Track keys (e.g. "Wien Hbf" vs "Wien").
      let cityInfo = effectiveCities[normalizedStopId] || effectiveCities[stop_id];
      if (!cityInfo) {
        const match = Object.entries(effectiveCities).find(([key]) =>
          matchStationNamesBound(stop_id, key),
        );
        if (match) cityInfo = match[1];
      }
      const filterName = normalizeStationNameForDisplay(stop_id);
      setSelectedStationName(filterName);
      setSelectedNormalizedName(normalizeStationNameForDisplay(stop_id));

      // Aggregate routes from all effectiveCities entries in the same city group.
      // This ensures clicking any marker (BoT grouped, BoT single, or NightTrain)
      // always shows all routes for the city, not just one station's routes.
      const allRouteIds = new Set();

      // 1. Add from directly-found cityInfo
      if (cityInfo?.stop_route_ids) {
        cityInfo.stop_route_ids.split(",").forEach((id) => {
          const t = id.trim();
          if (t) allRouteIds.add(t);
        });
      }

      // 2. Add from BoT grouped stations on the marker (when available)
      if (filteredStop.isGrouped && filteredStop.groupedStations) {
        filteredStop.groupedStations.forEach((station) => {
          const n = normalizeStationNameForLookup(station.stop_id);
          const info = effectiveCities[n] || effectiveCities[station.stop_id];
          if (info?.stop_route_ids) {
            info.stop_route_ids.split(",").forEach((id) => {
              const t = id.trim();
              if (t) allRouteIds.add(t);
            });
          }
        });
      }

      // 3. Find other effectiveCities entries with the same display city name.
      //    Handles NightTrain markers (which lose grouping info) and ensures
      //    all sub-stations of a city (e.g. "Wien", "Wien Meidling") contribute.
      if (filterName) {
        Object.entries(effectiveCities).forEach(([key, city]) => {
          if (!city?.stop_route_ids) return;
          if (normalizeStationNameForDisplay(key) === filterName) {
            city.stop_route_ids.split(",").forEach((id) => {
              const t = id.trim();
              if (t) allRouteIds.add(t);
            });
          }
        });
      }

      const routeIdsArray = Array.from(allRouteIds);
      if (routeIdsArray.length > 0) {
        setStopRouteIds(routeIdsArray);

        const routeCities = Object.values(effectiveCities).filter((viewCity) => {
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
      effectiveCities,
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
    if (!hasRouteFilter || !effectiveViewMapData || !stops?.length) return null;
    const activeId = String(selectedTrainRouteIds[0]);
    const route = Object.values(effectiveViewMapData).find(
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
  }, [hasRouteFilter, selectedTrainRouteIds, effectiveViewMapData, stops, normalizeStationNameForLookup]);

  // Set of station names/ids where a NightJet or EuroNight route starts or ends (for endpoint icon).
  // Include raw names and display-normalized names so Back-on-Track markers (e.g. displayName "Brussels") match.
  const nightTrainEndpointStations = useMemo(() => {
    const endpointSet = new Set();
    [...allNjRoutes, ...allEnRoutes].forEach((route) => {
      if (!route.stations?.length) return;
      const first = route.stations[0];
      const last = route.stations[route.stations.length - 1];
      [first, last].forEach((s) => {
        if (s?.name) {
          endpointSet.add(s.name);
          endpointSet.add(normalizeStationNameForDisplay(s.name));
        }
        if (s?.id) endpointSet.add(s.id);
      });
    });
    return endpointSet;
  }, [allNjRoutes, allEnRoutes, normalizeStationNameForDisplay]);

  // When NightTrain data is loaded and grouping is on, compute the set of city
  // names covered by NightTrain station markers. Back-on-Track markers for these
  // cities are hidden to avoid duplicates (NightTrain markers take priority
  // because they carry richer route info from the official NJ/EN APIs).
  const nightTrainCityNames = useMemo(() => {
    if (!isGrouped || !nightTrainsReady || !hasNightTrainOverlays) return null;

    // Use the same stations that NightTrainStationMarkers will render.
    const stations = [
      ...(selected ? filteredNjStations : allNjRoutes.flatMap((r) => r.stations || [])),
      ...(selected ? filteredEnStations : allEnRoutes.flatMap((r) => r.stations || [])),
    ];
    if (!stations.length) return null;

    const set = new Set();
    stations.forEach((s) => {
      const name = s?.name || s?.id;
      if (!name) return;
      const displayName = normalizeStationNameForDisplay(name);
      if (displayName) set.add(displayName);
    });
    return set.size > 0 ? set : null;
  }, [
    isGrouped,
    nightTrainsReady,
    selected,
    filteredNjStations,
    filteredEnStations,
    allNjRoutes,
    allEnRoutes,
  ]);

  const markers = useMapMarkers({
    filteredStops: routeFilterStops || filteredStops,
    stops,
    cities: effectiveCities,
    viewMapData: effectiveViewMapData,
    selected,
    stopId,
    stopRouteIds,
    isGrouped,
    hideIntermediateStations,
    stationsToSkip,
    normalizeStationNameForLookup,
    normalizeStationNameForDisplay,
    handleMarkerClick,
    trips: effectiveTrips,
    nightTrainEndpointStations,
    nightTrainCityNames,
  });

  const overallLoading = initialDataLoading;

  useEffect(() => {
    if (!overallLoading) {
      setLoadingProgress((p) => Math.max(p, 30));
    } else {
      setLoadingProgress(15);
      setLoadingMessage("Loading stations and routes...");
    }
  }, [overallLoading]);

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
  const effectiveEnOverlaysRaw = useMemo(() => {
    if (hasRouteFilter) return [];
    if (selectedNightTrainOverlay) {
      return selectedNightTrainOverlay.type === "euronight" ? [selectedNightTrainOverlay] : [];
    }
    return selected ? enOverlays : showRoutes ? allEnRoutes : [];
  }, [showRoutes, selected, selectedNightTrainOverlay, hasRouteFilter, allEnRoutes, enOverlays]);

  // OSM polyline overrides for EuroNight routes that hafas returns as straight lines.
  // Key = OSM relation IDs, value = fetched [lat,lon] array.
  const [enOsmPolylines, setEnOsmPolylines] = useState(new Map());

  // Returns true for EN 442/443 overlays that go via Humenné (not the Chopin/Warszawa variant).
  const isEN442Humenne = useCallback((ov) => {
    if (!/^EN\s*44[23]$/i.test(ov.lineName?.trim())) return false;
    return ov.stations?.some((s) =>
      /humen/i.test(s?.name || ""),
    );
  }, []);

  // Fetch static polyline for EN 442/443 Humenné–Praha
  useEffect(() => {
    const EN_KEY = "enHumenne";
    const needsFetch = allEnRoutes.some(isEN442Humenne);
    if (needsFetch && !enOsmPolylines.has(EN_KEY)) {
      fetch("/data/enHumennePolyline.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((coords) => {
          if (coords?.length > 0) {
            setEnOsmPolylines((prev) => {
              const next = new Map(prev);
              next.set(EN_KEY, coords);
              return next;
            });
          }
        })
        .catch((err) => console.error("[DynamicMap] EN polyline fetch failed:", err));
    }
  }, [allEnRoutes, enOsmPolylines, isEN442Humenne]);

  // Apply static polyline overrides to EuroNight overlays
  const effectiveEnOverlays = useMemo(() => {
    if (enOsmPolylines.size === 0) return effectiveEnOverlaysRaw;
    const osmCoords = enOsmPolylines.get("enHumenne");
    if (!osmCoords) return effectiveEnOverlaysRaw;

    return effectiveEnOverlaysRaw.map((ov) => {
      if (isEN442Humenne(ov)) {
        return { ...ov, coords: osmCoords };
      }
      return ov;
    });
  }, [effectiveEnOverlaysRaw, enOsmPolylines, isEN442Humenne]);

  useEffect(() => {
    if (!stops?.length || !cities || overallLoading) return;
    setFilteredStops(stops);
  }, [stops, cities, setFilteredStops, overallLoading]);

  // Only show NightJet/EuroNight station dots for stations that appear on at least one loaded route.
  // Avoids showing stations from nj-all-stations when we have no route for them.
  const njStationsFromRoutes = useMemo(() => {
    const seen = new Map();
    allNjRoutes.forEach((route) => {
      route.stations?.forEach((s) => {
        if (s?.location?.latitude == null || s?.location?.longitude == null) return;
        const key = s.id || `${s.location?.latitude}-${s.location?.longitude}`;
        if (key && !seen.has(key)) seen.set(key, s);
      });
    });
    return Array.from(seen.values());
  }, [allNjRoutes]);
  const enStationsFromRoutes = useMemo(() => {
    const seen = new Map();
    allEnRoutes.forEach((route) => {
      route.stations?.forEach((s) => {
        if (s?.location?.latitude == null || s?.location?.longitude == null) return;
        const key = s.id || `${s.location?.latitude}-${s.location?.longitude}`;
        if (key && !seen.has(key)) seen.set(key, s);
      });
    });
    return Array.from(seen.values());
  }, [allEnRoutes]);

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
          const route = effectiveViewMapData
            ? Object.values(effectiveViewMapData).find(
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
          stopsLoading={initialDataLoading}
          citiesLoading={false}
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
            stations={selected ? filteredNjStations : njStationsFromRoutes}
            endpointStations={nightTrainEndpointStations}
            hideIntermediateStations={hideIntermediateStations}
            backOnTrackCityNames={null}
            isGrouped={isGrouped}
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
            stations={selected ? filteredEnStations : enStationsFromRoutes}
            endpointStations={nightTrainEndpointStations}
            hideIntermediateStations={hideIntermediateStations}
            backOnTrackCityNames={null}
            isGrouped={isGrouped}
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
                    // Future route: tooltip already shows "opens …"; no panel
                    return;
                  }
                  handlePolylineClick(path.routeId);
                },
              }}
            >
              <Tooltip sticky>
                {(() => {
                  const route = effectiveViewMapData
                    ? Object.values(effectiveViewMapData).find(
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
            (id) => !shouldHideRouteDueToFutureDate(id, effectiveTrips),
          ) ?? []
        }
        nightTrainOverlay={selectedNightTrainOverlay}
      />
    </>
  );
};

export default TrainMap;
