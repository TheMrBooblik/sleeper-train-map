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

const { MapContainer, Marker, TileLayer, Polyline, Tooltip, useMap } = ReactLeaflet;
import "leaflet/dist/leaflet.css";

import Filter from "src/components/Filter";
import { useInitialData } from "../../hooks/requests/useInitialData";
import { normalizeStationNameForLookup } from "../../hooks/requests/useCities";
import { normalizeCity } from "../../lib/pkpTrainKeyExtract";
import TrainBottomBar from "@components/TrainBottomBar";
import TrainDetailPanel, {
  MOBILE_SHEET_PEEK_VH,
  DESKTOP_PANEL_WIDTH_PX,
} from "@components/TrainDetailPanel";
import { MOBILE_MQ } from "../../hooks/useIsMobile";
import ZoomControl from "@components/ZoomControl";
import LocationControl from "@components/LocationControl";
import { stationsToSkip } from "../../data/stationsToSkip";
import { tileLoadingOptions as buildTileLoadingOptions } from "./utils/tileLoadingOptions";

import {
  normalizeStationNameForDisplay,
  matchStationNames,
  stationsAreNearby,
} from "./utils/stationNameUtils";
import {
  shouldHideRouteDueToFutureDate,
  selectedRoutesWithLines,
  hasUnknownStart,
  routeHasNotStartedYet,
} from "./utils/routeStyleUtils";
import { formatTrainNumber } from "../../lib/operatorAgencies.mjs";
import {
  selectedCityMatcher,
  stationFirstEndpoints,
  routesBetweenStations,
  endpointsInDirection,
} from "../../lib/stationFirst.mjs";
import { orderByPromotion } from "../../lib/operatorPromotion.mjs";
import { splitViaString } from "../../lib/viaSplit.mjs";
import { useRoutePaths } from "./hooks/useRoutePaths";
import { useMapMarkers } from "./hooks/useMapMarkers";
import LoadingOverlay from "./components/LoadingOverlay";
import MapClickHandler from "./components/MapClickHandler";
import MapViewportTracker from "./components/MapViewportTracker";
import MarkerTooltipGuard from "./components/MarkerTooltipGuard";
import { liftForDarkMap } from "../../lib/mapTheme.mjs";
import { upcomingRun, rowNextDeparture } from "../../lib/nextDeparture.mjs";

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

/**
 * True on devices with a real pointer (desktop mouse / trackpad).
 * Used for hover-only behaviour: route highlighting and cursor-following
 * line tooltips. Touch devices have no cursor, so they keep the tooltip
 * anchored to the line instead of popping it up under the finger.
 */
function hasFinePointer() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function MapFlyController({ target, onDone }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lon], target.zoom ?? 8, { duration: 1.2 });
    onDone();
  }, [target, map, onDone]);
  return null;
}

/**
 * Frames the selected route into the part of the map the detail panel does not
 * cover. Clicking a line used to open the panel over the very line you clicked
 * — on mobile the sheet takes the lower half, on desktop a right sidebar — so
 * the fit is padded by that geometry instead of centring on the full viewport.
 * Fits once per route (the ref guard), since `positions` is a fresh array on
 * every recompute of the paths.
 */
function FitSelectedRoute({ routeId, positions }) {
  const map = useMap();
  const fittedRef = useRef(null);

  useEffect(() => {
    if (!routeId) {
      fittedRef.current = null;
      return;
    }
    if (!positions?.length || fittedRef.current === routeId) return;

    const bounds = Leaflet.latLngBounds(positions);
    if (!bounds.isValid()) return;
    fittedRef.current = routeId;

    const isMobile = window.matchMedia(MOBILE_MQ).matches;
    const paddingBottomRight = isMobile
      ? [16, Math.round(window.innerHeight * MOBILE_SHEET_PEEK_VH) + 16]
      : [DESKTOP_PANEL_WIDTH_PX + 16, 16];

    map.fitBounds(bounds, {
      paddingTopLeft: [16, 16],
      paddingBottomRight,
      // Short routes should not slam the map to street level.
      maxZoom: 9,
      animate: true,
      duration: 0.8,
    });
  }, [routeId, positions, map]);

  return null;
}

const TrainMap = ({
  className,
  isGrouped,
  showRoutes = true,
  hideIntermediateStations = false,
  showRailwayOverlay = false,
  isDarkMap = false,
  searchTarget,
  onSearchProcessed,
  onStationSelect,
  ...rest
}) => {
  const [sidebarDisabled, setSidebarDisabled] = useState(false);
  // Read once: Leaflet takes these at construction time, and the connection
  // hints behind them are advisory anyway.
  const tileLoadingOptions = useMemo(
    () => buildTileLoadingOptions({ isMobile: Leaflet.Browser.mobile }),
    [],
  );
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
  const [showTooltips, setShowTooltips] = useState(false);
  const [stopRouteIds, setStopRouteIds] = useState();
  const [selectedStationName, setSelectedStationName] = useState("");
  const [selectedNormalizedName, setSelectedNormalizedName] = useState("");
  const [selectedStationLat, setSelectedStationLat] = useState(null);
  const [selectedStationLon, setSelectedStationLon] = useState(null);
  const [selectedTrainRouteIds, setSelectedTrainRouteIds] = useState([]);
  // route_id → direction (0/1) when the open routes were picked by clicking a
  // second station: the direction that runs from the selected station to it.
  const [pairDirections, setPairDirections] = useState(null);
  const [isTrainDetailPanelOpen, setIsTrainDetailPanelOpen] = useState(false);
  const [hoveredRouteId, setHoveredRouteId] = useState(null);
  const [cdRouteFilterStops, setCdRouteFilterStops] = useState(null);
  const cdTrainsCacheRef = useRef(null);
  const [mapZoom, setMapZoom] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);

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
    setStopId(null);
    setSelected(false);
    setSelectedStationName("");
    setSelectedNormalizedName("");
    setSelectedStationLat(null);
    setSelectedStationLon(null);
    setStopRouteIds([]);
    setFilteredStops(stops);
    setPairDirections(null);
  }, [setFilteredStops, stops]);

  const openRoutes = useCallback((routeIds, directions = null) => {
    const idsArray = Array.isArray(routeIds) ? routeIds : [routeIds];
    startTransition(() => {
      setSelectedTrainRouteIds(idsArray);
      setPairDirections(directions);
      setIsTrainDetailPanelOpen(true);
    });
  }, []);

  const handlePolylineClick = useCallback(
    (routeIds) => openRoutes(routeIds),
    [openRoutes],
  );

  const closeTrainDetailPanel = useCallback(() => {
    setIsTrainDetailPanelOpen(false);
    setSelectedTrainRouteIds([]);
    setPairDirections(null);
  }, []);

  // Hover preview is desktop-only — touch has no meaningful hover state.
  const handleRouteHover = useCallback((routeId) => {
    if (!hasFinePointer()) return;
    setHoveredRouteId(routeId ? String(routeId) : null);
  }, []);

  const handleRouteLeave = useCallback(() => {
    setHoveredRouteId(null);
  }, []);

  const handleViewportChange = useCallback(({ zoom, bounds }) => {
    setMapZoom(zoom);
    setMapBounds(bounds);
  }, []);

  // Guard against stale hover state. If the bottom bar is not in the
  // active route-list mode, we should not keep any hover preview dimming.
  useEffect(() => {
    if (!selected || isTrainDetailPanelOpen) {
      setHoveredRouteId(null);
    }
  }, [selected, isTrainDetailPanelOpen]);

  const handleFilterClose = useCallback(() => {
    if (selectedTrainRouteIds?.length > 0) {
      closeTrainDetailPanel();
    } else {
      removeFilter();
    }
  }, [selectedTrainRouteIds, closeTrainDetailPanel, removeFilter]);

  const matchStationNamesBound = useCallback(
    (a, b) => matchStationNames(a, b, normalizeStationNameForLookup),
    [normalizeStationNameForLookup],
  );

  // Coordinates for every station name the cities index can be keyed by, so a
  // name match below can be checked against where the two stations actually
  // are. Without it "Glasgow Central" reaches Glasgow, Montana and pulls the
  // Amtrak Empire Builder's stops onto a Scottish click.
  const stationCoordsByName = useMemo(() => {
    const index = new Map();
    (stops || []).forEach((stop) => {
      if (!stop?.stop_id) return;
      const { stop_lat: lat, stop_lon: lon } = stop;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const normalized = normalizeStationNameForLookup(stop.stop_id);
      if (normalized && !index.has(normalized)) index.set(normalized, [lat, lon]);
      if (!index.has(stop.stop_id)) index.set(stop.stop_id, [lat, lon]);
    });
    return index;
  }, [stops, normalizeStationNameForLookup]);

  /**
   * A route as the traveller at the selected station would board it
   * (src/lib/stationFirst.mjs) — the bottom bar's own answer, from the same
   * inputs, so the line tooltip, the route chip and the train the detail panel
   * opens on all say what the chip said: a click on Milan reads "Milano Porta
   * Garibaldi → Bruxelles Midi" everywhere, not the row's stated direction.
   * null with no station selected, or when the route does not name one in the
   * selected city (it reached the station through a city-group match).
   */
  const stationFirstFor = useMemo(() => {
    if (!selected || !selectedNormalizedName) return null;
    const inSelectedCity = selectedCityMatcher(
      selectedNormalizedName,
      normalizeStationNameForDisplay,
    );
    const isKnownStation = (name) =>
      !!cities?.[normalizeStationNameForLookup(String(name ?? ""))];
    const coordsOf = (name) =>
      stationCoordsByName.get(
        normalizeStationNameForLookup(String(name ?? "")),
      ) ||
      stationCoordsByName.get(name) ||
      null;
    return (route) => {
      if (!route) return null;
      // Opened by clicking a second station: the train running toward it.
      const pairDirection = pairDirections?.[String(route.route_id)];
      if (pairDirection === 0 || pairDirection === 1) {
        const ends = endpointsInDirection(route, pairDirection, {
          inFrom: inSelectedCity,
          splitVia: (via) => splitViaString(via, isKnownStation),
        });
        if (ends) return ends;
      }
      const ends = stationFirstEndpoints(route, {
        inSelectedCity,
        splitVia: (via) => splitViaString(via, isKnownStation),
        coordsOf,
      });
      return ends.fromIsSelected ? ends : null;
    };
  }, [
    selected,
    selectedNormalizedName,
    cities,
    stationCoordsByName,
    pairDirections,
  ]);

  /**
   * A name match only counts when the two stations are in the same place.
   * `lat`/`lon` are the clicked station's; a candidate with no coordinates is
   * kept, since there is nothing to disprove.
   */
  const isNearbyStationName = useCallback(
    (lat, lon, candidateName) => {
      const coords = stationCoordsByName.get(candidateName);
      if (!coords) return true;
      return stationsAreNearby(lat, lon, coords[0], coords[1]);
    },
    [stationCoordsByName],
  );

  /**
   * Every route calling at a clicked station, across its whole city group —
   * so clicking any marker always shows all routes for the city.
   */
  const routeIdsAtStop = useCallback(
    (filteredStop) => {
      const { stop_id } = filteredStop;
      const clickedLat = filteredStop?.stop_lat;
      const clickedLon = filteredStop?.stop_lon;
      const normalizedStopId = normalizeStationNameForLookup(stop_id);
      // Direct key lookup first; fallback to fuzzy match when display variants differ.
      let cityInfo = cities[normalizedStopId] || cities[stop_id];
      if (!cityInfo) {
        const match = Object.entries(cities).find(
          ([key]) =>
            matchStationNamesBound(stop_id, key) &&
            isNearbyStationName(clickedLat, clickedLon, key),
        );
        if (match) cityInfo = match[1];
      }
      const filterName = normalizeStationNameForDisplay(stop_id);

      const allRouteIds = new Set();
      const addIds = (csv) =>
        csv.split(",").forEach((id) => {
          const t = id.trim();
          if (t) allRouteIds.add(t);
        });

      // 1. Add from directly-found cityInfo
      if (cityInfo?.stop_route_ids) addIds(cityInfo.stop_route_ids);

      // 2. Add from BoT grouped stations on the marker (when available)
      if (filteredStop.isGrouped && filteredStop.groupedStations) {
        filteredStop.groupedStations.forEach((station) => {
          const n = normalizeStationNameForLookup(station.stop_id);
          const info = cities[n] || cities[station.stop_id];
          if (info?.stop_route_ids) addIds(info.stop_route_ids);
        });
      }

      // 3. Find other city entries with the same display city name or fuzzy-matching name.
      // The fuzzy match covers diacritic variants (e.g. "Przemysl Gl." vs "Przemyśl Gł.")
      // where NightJet API uses ASCII station names but BoT uses local diacritics.
      if (filterName) {
        Object.entries(cities).forEach(([key, city]) => {
          if (!city?.stop_route_ids) return;
          // Both tests are name-only, and both produce cross-continent false
          // positives on their own: the display name buckets "Florence Amtrak
          // Station" (South Carolina) with Firenze, and the fuzzy matcher pairs
          // "Bar" (Montenegro) with "Boston Bar" in British Columbia. Either
          // one used to hand the clicked station that route's entire stop list.
          if (
            (normalizeStationNameForDisplay(key) === filterName ||
              matchStationNamesBound(stop_id, key)) &&
            isNearbyStationName(clickedLat, clickedLon, key)
          ) {
            addIds(city.stop_route_ids);
          }
        });
      }
      return Array.from(allRouteIds);
    },
    [
      cities,
      matchStationNamesBound,
      isNearbyStationName,
      normalizeStationNameForLookup,
      normalizeStationNameForDisplay,
    ],
  );

  /**
   * With a station selected, a click on another station in a different city
   * opens the routes that ride from the first to the second — as if the line
   * between them had been clicked — rather than switching the selection.
   * Returns false when no drawn route links the two, so the click falls back
   * to selecting the new station.
   */
  const openRoutesToStop = useCallback(
    (filteredStop) => {
      if (!selected || !stopRouteIds?.length || !viewMapData) return false;
      const inSelectedCity = selectedCityMatcher(
        selectedNormalizedName,
        normalizeStationNameForDisplay,
      );
      // Another station in the selected city is a new station, not a trip.
      if (inSelectedCity(filteredStop.stop_id)) return false;
      const clickedName = normalizeStationNameForDisplay(filteredStop.stop_id);
      if (!clickedName) return false;

      const atClicked = new Set(routeIdsAtStop(filteredStop));
      // Only routes the map draws for the selection: a closed season's route
      // still calls at both stations by name but has no line to "click".
      const drawn = selectedRoutesWithLines(stopRouteIds, trips, viewMapData);
      const rows = stopRouteIds
        .map((id) => String(id).trim())
        .filter(
          (id) =>
            atClicked.has(id) &&
            drawn.has(id) &&
            !shouldHideRouteDueToFutureDate(id, trips, viewMapData[id]),
        )
        .map((id) => viewMapData[id])
        .filter(Boolean);
      if (!rows.length) return false;

      const isKnownStation = (name) =>
        !!cities?.[normalizeStationNameForLookup(String(name ?? ""))];
      // Ranked as the bottom bar ranks them, so the route the map frames is
      // the one the bar would have listed first: trains not running yet last.
      const isNotRunning = (row) =>
        hasUnknownStart(row?.route_id, trips) ||
        (row?.draw_as_active === true && routeHasNotStartedYet(row)) ||
        Boolean(rowNextDeparture(row));
      const ranked = orderByPromotion(rows, undefined, { isNotRunning });
      const between = routesBetweenStations(ranked, {
        inFrom: inSelectedCity,
        inTo: selectedCityMatcher(clickedName, normalizeStationNameForDisplay),
        splitVia: (via) => splitViaString(via, isKnownStation),
      });
      if (!between.length) return false;

      const directions = {};
      between.forEach(({ route, direction }) => {
        if (direction != null) directions[String(route.route_id)] = direction;
      });
      openRoutes(
        between.map(({ route }) => String(route.route_id)),
        Object.keys(directions).length ? directions : null,
      );
      return true;
    },
    [
      selected,
      stopRouteIds,
      viewMapData,
      trips,
      cities,
      selectedNormalizedName,
      routeIdsAtStop,
      openRoutes,
      normalizeStationNameForLookup,
      normalizeStationNameForDisplay,
    ],
  );

  const handleMarkerClick = useCallback(
    (filteredStop, { fromSearch = false } = {}) => {
      // First real map interaction — lets the welcome tour dismiss itself.
      onStationSelect?.();
      const { stop_id } = filteredStop;
      const clickedLat = filteredStop?.stop_lat;
      const clickedLon = filteredStop?.stop_lon;
      // Close filter only when user clicks the *same logical station* again.
      // Compare against the previously selected stopId using the name matcher,
      // and against where it was — two same-named stations on different
      // continents are not the user clicking the same one twice.
      // This avoids accidentally closing when the user clicks a different station
      // in the same city (e.g. another Brussels-area stop).
      if (
        selected &&
        stopId &&
        matchStationNamesBound(stop_id, stopId) &&
        stationsAreNearby(
          clickedLat,
          clickedLon,
          selectedStationLat,
          selectedStationLon,
        )
      ) {
        removeFilter();
        return;
      }

      // A second station on the selected station's routes: open the trains
      // between the two. A search always selects the station it names.
      if (!fromSearch && openRoutesToStop(filteredStop)) return;

      // New station selected: update filter + routes for this station.
      // Directions picked toward a second station were relative to the old one.
      setPairDirections(null);
      setStopId(stop_id);
      setSelectedStationLat(filteredStop.stop_lat);
      setSelectedStationLon(filteredStop.stop_lon);
      const filterName = normalizeStationNameForDisplay(stop_id);
      setSelectedStationName(filterName);
      setSelectedNormalizedName(filterName);

      const routeIdsArray = routeIdsAtStop(filteredStop);
      if (routeIdsArray.length > 0) {
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
    },
    [
      cities,
      stops,
      setFilteredStops,
      stopId,
      selected,
      selectedStationLat,
      selectedStationLon,
      removeFilter,
      openRoutesToStop,
      routeIdsAtStop,
      matchStationNamesBound,
      normalizeStationNameForLookup,
      normalizeStationNameForDisplay,
      onStationSelect,
    ],
  );

  const [flyToTarget, setFlyToTarget] = useState(null);

  // When the header search selects a station, fly the map there and select it.
  useEffect(() => {
    if (!searchTarget) return;
    setFlyToTarget({ lat: searchTarget.flyTo.lat, lon: searchTarget.flyTo.lon, zoom: searchTarget.zoom });
    handleMarkerClick(searchTarget.stop, { fromSearch: true });
    onSearchProcessed?.();
  }, [searchTarget]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [
    hasRouteFilter,
    selectedTrainRouteIds,
    viewMapData,
    stops,
    normalizeStationNameForLookup,
  ]);

  // For selected EC/EN routes, use CD timetable stops as marker source.
  // Station names from cd.cz are matched against BoT stops data for coordinates.
  useEffect(() => {
    if (!hasRouteFilter || !stops?.length) {
      setCdRouteFilterStops(null);
      return;
    }

    // Check if the selected route is an EC or EN train (both served by cd.cz timetables)
    const activeId = String(selectedTrainRouteIds[0]);
    let cdTrainNumber = null;
    Object.values(trips || {}).forEach((trip) => {
      if (trip?.route_id?.toString() === activeId) {
        const m = (trip.trip_short_name || "").match(/^\s*(?:EC|EN)\s+(\d+)/i);
        if (m) cdTrainNumber = m[1];
      }
    });

    const activeRoute = Object.values(viewMapData || {}).find(
      (r) => r?.route_id?.toString() === activeId,
    );

    if (!cdTrainNumber) {
      setCdRouteFilterStops(null);
      return;
    }

    let cancelled = false;

    const buildStopsFromCD = (cdData) => {
      const trainData = cdData?.trains?.[cdTrainNumber];
      if (!trainData?.stops?.length) return null;

      // Through-car guard: a compound label like "EN 443 / IC 406" gets reduced
      // to a single CD train number (here "443"), but that train is only ONE leg
      // of the journey and may run to a DIFFERENT destination (EN 443's cars
      // split at Bohumín — some to Humenné, some on to Warszawa as IC 406). Only
      // trust the CD stop list when this train actually serves BOTH of the
      // route's own endpoints; otherwise fall back to the Back-on-Track corridor.
      // City-level (not exact) match so "Praha hl.n." == "Praha-Michle autovlak".
      const cdCities = new Set(trainData.stops.map((s) => normalizeCity(s.name)));
      const routeOrigin = normalizeCity(activeRoute?.origin_trip_0);
      const routeDest = normalizeCity(activeRoute?.destination_trip_0);
      if (
        routeOrigin &&
        routeDest &&
        !(cdCities.has(routeOrigin) && cdCities.has(routeDest))
      ) {
        return null;
      }

      const stopLookup = new Map();
      stops.forEach((stop) => {
        if (!stop.stop_id) return;
        const n = normalizeStationNameForLookup(stop.stop_id);
        if (n && !stopLookup.has(n)) stopLookup.set(n, stop);
        if (!stopLookup.has(stop.stop_id)) stopLookup.set(stop.stop_id, stop);
      });

      const result = [];
      const seen = new Set();
      trainData.stops.forEach((cdStop) => {
        if (!cdStop.name) return;
        const n = normalizeStationNameForLookup(cdStop.name);
        const match = stopLookup.get(n) || stopLookup.get(cdStop.name);
        if (match?.stop_lat && match?.stop_lon && !seen.has(n)) {
          seen.add(n);
          result.push({ stop_id: cdStop.name, stop_lat: match.stop_lat, stop_lon: match.stop_lon });
        }
      });
      return result.length > 0 ? result : null;
    };

    const loadCDStops = async () => {
      try {
        if (cdTrainsCacheRef.current) {
          if (!cancelled) setCdRouteFilterStops(buildStopsFromCD(cdTrainsCacheRef.current));
          return;
        }
        const response = await fetch("/api/cd-trains");
        if (!response.ok) {
          if (!cancelled) setCdRouteFilterStops(null);
          return;
        }
        const data = await response.json();
        cdTrainsCacheRef.current = data;
        if (!cancelled) setCdRouteFilterStops(buildStopsFromCD(data));
      } catch {
        if (!cancelled) setCdRouteFilterStops(null);
      }
    };

    loadCDStops();
    return () => { cancelled = true; };
  }, [hasRouteFilter, selectedTrainRouteIds, trips, stops, normalizeStationNameForLookup]);

  const markers = useMapMarkers({
    filteredStops: cdRouteFilterStops || routeFilterStops || filteredStops,
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
    routeFilteredMode: hasRouteFilter,
    mapZoom,
    mapBounds,
  });

  const overallLoading = initialDataLoading;
  useEffect(() => {
    if (!overallLoading) {
      setShowTooltips(true);
    }
  }, [overallLoading]);
  const hasSelection = selected || hasRouteFilter;

  useEffect(() => {
    if (!stops?.length || !cities || overallLoading) return;
    setFilteredStops(stops);
  }, [stops, cities, setFilteredStops, overallLoading]);

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

  const filterName = hasRouteFilter
    ? (() => {
        const route = viewMapData
          ? Object.values(viewMapData).find(
              (r) =>
                r?.route_id?.toString() === String(selectedTrainRouteIds[0]),
            )
          : null;
        if (!route) return "Route";
        // Opened from a station: name the train the traveller boards there.
        const ends = stationFirstFor?.(route);
        const trainNumber = formatTrainNumber(
          (ends && route[`trip_short_name_${ends.direction}`]) ||
            route.trip_short_name_0 ||
            route.trip_short_name_1 ||
            "",
          route.bot_agency_id || route.agency_id,
        );
        const segment = ends
          ? `${ends.from} → ${ends.to}`
          : `${route.origin_trip_0 || "?"} → ${route.destination_trip_0 || "?"}`;
        return trainNumber ? `${trainNumber}: ${segment}` : `Route: ${segment}`;
      })()
    : selectedStationName || stopId;

  // Which train the detail panel lists first, per selected route: the one the
  // bottom bar's chip named, so the panel opens on the train the user picked.
  const firstDirectionByRoute = useMemo(() => {
    if (!stationFirstFor || !selectedTrainRouteIds?.length || !viewMapData)
      return null;
    const out = {};
    selectedTrainRouteIds.forEach((id) => {
      const ends = stationFirstFor(viewMapData[String(id)]);
      if (ends) out[String(id)] = ends.direction;
    });
    return Object.keys(out).length ? out : null;
  }, [stationFirstFor, selectedTrainRouteIds, viewMapData]);

  const visibleRoutePaths = useMemo(() => {
    if (!hoveredRouteId || routePaths.length === 0) return routePaths;

    // Draw hovered route last so it stays fully visible on top of overlapping lines.
    const nonHovered = [];
    const hovered = [];
    routePaths.forEach((path) => {
      if (String(path.routeId) === hoveredRouteId) {
        hovered.push(path);
      } else {
        nonHovered.push(path);
      }
    });

    return [...nonHovered, ...hovered];
  }, [routePaths, hoveredRouteId]);

  // Only apply route-dimming preview while the bottom bar route list is active.
  const shouldApplyHoverPreview =
    !!hoveredRouteId && selected && !isTrainDetailPanelOpen;

  // Desktop: the line tooltip follows the cursor (Leaflet `sticky`), so it
  // shows up right where you point. Without it Leaflet anchors the tooltip to
  // the middle of the line, which can be far off screen on long routes.
  // Computed once per mount, and at render time on purpose: Leaflet reads
  // tooltip options only when the tooltip is created, so a value arriving
  // later from an effect would be ignored. Safe because the map is
  // client-only (`ssr: false`), so `window` exists on the first render.
  const stickyLineTooltip = useMemo(() => hasFinePointer(), []);

  // Every coordinate of the selected route, so the map can frame it clear of
  // the detail panel. `useRoutePaths` already narrows to the selection, but
  // filter by id anyway: a route can contribute several path segments.
  const activeRouteId = hasRouteFilter
    ? String(selectedTrainRouteIds[0])
    : null;
  const selectedRoutePositions = useMemo(() => {
    if (!activeRouteId || !routePaths?.length) return null;
    const points = [];
    routePaths.forEach((path) => {
      if (String(path.routeId) !== activeRouteId) return;
      if (Array.isArray(path.positions)) points.push(...path.positions);
    });
    return points.length ? points : null;
  }, [activeRouteId, routePaths]);

  return (
    <>
      {/* Initial fast overlay: only blocks while GTFS (stations/routes) load (~1-2s) */}
      {showLoading && (
        <LoadingOverlay
          stopsLoading={initialDataLoading}
          citiesLoading={false}
        />
      )}

      <MapContainer
        className={mapClassName}
        zoomControl={false}
        preferCanvas={true}
        {...rest}
      >
        <TileLayer
          // One origin, not the deprecated {s} subdomains OSM asks tile users
          // to drop: over HTTP/2 a single connection multiplexes every tile,
          // while a/b/c force three TLS handshakes — the opposite of what a
          // high-latency link wants.
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          // Required by the OSM tile usage policy. The SEO route maps carried
          // it; the interactive map, which is where nearly everyone sees these
          // tiles, did not.
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
          // The dark theme is these same tiles under a CSS filter keyed on
          // this class (globals.css). Static on purpose: Leaflet reads
          // `className` once, so the theme switches via <html data-theme>
          // rather than by re-creating the layer. The OpenRailwayMap overlay
          // has no class, so its colour-coded track types stay unfiltered.
          className="basemap-tiles"
          {...tileLoadingOptions}
        />
        {showRailwayOverlay && (
          <TileLayer
            url="https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png"
            zIndex={2}
            maxZoom={19}
            attribution='Railway overlay: <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA 2.0)'
          />
        )}
        <MapClickHandler
          hasSelection={hasSelection}
          onClearFilter={handleFilterClose}
        />
        <MapViewportTracker onViewportChange={handleViewportChange} />
        <MarkerTooltipGuard />
        <MapFlyController
          target={flyToTarget}
          onDone={() => setFlyToTarget(null)}
        />
        <FitSelectedRoute
          routeId={activeRouteId}
          positions={selectedRoutePositions}
        />
        <Filter
          selected={hasSelection}
          filterName={filterName}
          onClose={handleFilterClose}
        />
        <ZoomControl className="outline-none" />
        <LocationControl />

        {visibleRoutePaths.length > 0 &&
          visibleRoutePaths.map((path) => {
            const resolvedOpacity = shouldApplyHoverPreview
              ? String(path.routeId) === hoveredRouteId
                ? 0.95
                : 0.2
              : path.pathOptions.opacity;
            const resolvedWeight = shouldApplyHoverPreview
              ? String(path.routeId) === hoveredRouteId
                ? Math.max(
                    path.pathOptions.weight || 1,
                    (path.pathOptions.weight || 4) + 1.5,
                  )
                : path.pathOptions.weight
              : path.pathOptions.weight;
            return (
              <React.Fragment key={path.key}>
                {/* Invisible wide hit trap — large touch/click target without altering visual weight */}
                <Polyline
                  key={`${path.key}-hit`}
                  positions={path.positions}
                  pathOptions={{
                    color: "transparent",
                    weight: 24,
                    opacity: 0,
                    fillOpacity: 0,
                    interactive: true,
                    cursor: "pointer",
                  }}
                  eventHandlers={{
                    click: (e) => {
                      e.originalEvent.stopPropagation();
                      handlePolylineClick(path.routeId);
                    },
                  }}
                >
                  <Tooltip sticky={stickyLineTooltip}>
                    {(() => {
                      if (path.isBusConnector) {
                        return path.busFrom && path.busTo
                          ? `Bus replacement: ${path.busFrom} → ${path.busTo}`
                          : "Bus replacement";
                      }
                      const route = viewMapData
                        ? Object.values(viewMapData).find(
                            (r) =>
                              r?.route_id &&
                              r.route_id.toString() === String(path.routeId),
                          )
                        : null;
                      if (!route) return `Route ${path.routeId}`;

                      // With a station selected, the train as the traveller
                      // there boards it — the bottom bar's words for the line.
                      const ends = stationFirstFor?.(route);
                      const isDirectionOne = ends
                        ? ends.direction === 1
                        : path.key.includes("-1-");
                      const origin = ends
                        ? ends.from
                        : isDirectionOne
                          ? route.origin_trip_1 || route.origin_trip_0
                          : route.origin_trip_0 || route.origin_trip_1;
                      const destination = ends
                        ? ends.to
                        : isDirectionOne
                          ? route.destination_trip_1 || route.destination_trip_0
                          : route.destination_trip_0 ||
                            route.destination_trip_1;
                      const trainNumber = formatTrainNumber(
                        isDirectionOne
                          ? route.trip_short_name_1 || route.trip_short_name_0
                          : route.trip_short_name_0 || route.trip_short_name_1,
                        route.bot_agency_id || route.agency_id,
                      );

                      const segment = `${origin || "?"} → ${destination || "?"}`;
                      const label = trainNumber
                        ? `${trainNumber}: ${segment}`
                        : `Route: ${segment}`;
                      if (!path.isFuture) return label;
                      // A seasonal train says so: "Summer only, next season
                      // from 25 Jun 2027" rather than a bare date.
                      const run = upcomingRun(route);
                      return run?.seasonal
                        ? `${label} · ${run.badge}, next season from ${run.nextDepartureText}`
                        : `${label} · from ${formatFutureDate(path.futureStartDate)}`;
                    })()}
                  </Tooltip>
                </Polyline>
                {/* Visual polyline — non-interactive, purely decorative */}
                <Polyline
                  key={`${path.key}-vis`}
                  positions={path.positions}
                  pathOptions={{
                    ...path.pathOptions,
                    // Navy and midnight-blue brands vanish on the dark
                    // basemap; lifted to a visible lightness, same hue.
                    color: isDarkMap
                      ? liftForDarkMap(path.pathOptions.color)
                      : path.pathOptions.color,
                    cursor: "pointer",
                    opacity: resolvedOpacity,
                    weight: resolvedWeight,
                    interactive: false,
                  }}
                />
              </React.Fragment>
            );
          })}
        {markers}
      </MapContainer>

      <div ref={sidebarRef}>
        <TrainBottomBar
          isOpen={selected}
          sidebarDisabled={sidebarDisabled}
          setSidebarDisabled={setSidebarDisabled}
          stopId={stopId}
          stopRouteIds={stopRouteIds}
          selectedNormalizedName={selectedNormalizedName}
          isDetailPanelOpen={isTrainDetailPanelOpen}
          onRouteClick={handlePolylineClick}
          onRouteHover={handleRouteHover}
          onRouteLeave={handleRouteLeave}
          viewMapData={viewMapData}
          trips={trips}
          cities={cities}
          stationCoords={stationCoordsByName}
          isDarkMap={isDarkMap}
        />
      </div>

      <TrainDetailPanel
        isOpen={isTrainDetailPanelOpen}
        onClose={closeTrainDetailPanel}
        tripsData={trips}
        viewMapData={viewMapData}
        selectedStation={selectedStationName}
        firstDirectionByRoute={firstDirectionByRoute}
        isDarkMap={isDarkMap}
        selectedRouteIds={
          selectedTrainRouteIds?.filter(
            (id) => !shouldHideRouteDueToFutureDate(id, trips, viewMapData?.[id]),
          ) ?? []
        }
      />
    </>
  );
};

export default TrainMap;
