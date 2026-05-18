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
import TrainBottomBar from "@components/TrainBottomBar";
import TrainDetailPanel from "@components/TrainDetailPanel";
import ZoomControl from "@components/ZoomControl";
import LocationControl from "@components/LocationControl";
import { stationsToSkip } from "../../data/stationsToSkip";

import {
  normalizeStationNameForDisplay,
  matchStationNames,
} from "./utils/stationNameUtils";
import {
  shouldHideRouteDueToFutureDate,
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
} from "./utils/routeStyleUtils";
import { useRoutePaths } from "./hooks/useRoutePaths";
import { useMapMarkers } from "./hooks/useMapMarkers";
import LoadingOverlay from "./components/LoadingOverlay";
import MapClickHandler from "./components/MapClickHandler";
import MapViewportTracker from "./components/MapViewportTracker";

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

function MapFlyController({ target, onDone }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lon], target.zoom ?? 8, { duration: 1.2 });
    onDone();
  }, [target, map, onDone]);
  return null;
}

const TrainMap = ({
  className,
  isGrouped,
  showRoutes = true,
  hideIntermediateStations = false,
  searchTarget,
  onSearchProcessed,
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
  const [showTooltips, setShowTooltips] = useState(false);
  const [stopRouteIds, setStopRouteIds] = useState();
  const [selectedStationName, setSelectedStationName] = useState("");
  const [selectedNormalizedName, setSelectedNormalizedName] = useState("");
  const [selectedStationLat, setSelectedStationLat] = useState(null);
  const [selectedStationLon, setSelectedStationLon] = useState(null);
  const [selectedTrainRouteIds, setSelectedTrainRouteIds] = useState([]);
  const [isTrainDetailPanelOpen, setIsTrainDetailPanelOpen] = useState(false);
  const [hoveredRouteId, setHoveredRouteId] = useState(null);
  const [gtfsRouteFilterStops, setGtfsRouteFilterStops] = useState(null);
  const gtfsStopsCacheRef = useRef(new Map());
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
  }, [setFilteredStops, stops]);

  const handlePolylineClick = useCallback((routeIds) => {
    const idsArray = Array.isArray(routeIds) ? routeIds : [routeIds];
    startTransition(() => {
      setSelectedTrainRouteIds(idsArray);
      setIsTrainDetailPanelOpen(true);
    });
  }, []);

  const closeTrainDetailPanel = useCallback(() => {
    setIsTrainDetailPanelOpen(false);
    setSelectedTrainRouteIds([]);
  }, []);

  const handleRouteHover = useCallback((routeId) => {
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
      // Direct key lookup first; fallback to fuzzy match when display variants differ.
      let cityInfo = cities[normalizedStopId] || cities[stop_id];
      if (!cityInfo) {
        const match = Object.entries(cities).find(([key]) =>
          matchStationNamesBound(stop_id, key),
        );
        if (match) cityInfo = match[1];
      }
      const filterName = normalizeStationNameForDisplay(stop_id);
      setSelectedStationName(filterName);
      setSelectedNormalizedName(normalizeStationNameForDisplay(stop_id));

      // Aggregate routes from all city entries in the same city group.
      // This ensures clicking any marker always shows all routes for the city.
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
          const info = cities[n] || cities[station.stop_id];
          if (info?.stop_route_ids) {
            info.stop_route_ids.split(",").forEach((id) => {
              const t = id.trim();
              if (t) allRouteIds.add(t);
            });
          }
        });
      }

      // 3. Find other city entries with the same display city name or fuzzy-matching name.
      // The fuzzy match covers diacritic variants (e.g. "Przemysl Gl." vs "Przemyśl Gł.")
      // where NightJet API uses ASCII station names but BoT uses local diacritics.
      if (filterName) {
        Object.entries(cities).forEach(([key, city]) => {
          if (!city?.stop_route_ids) return;
          if (
            normalizeStationNameForDisplay(key) === filterName ||
            matchStationNamesBound(stop_id, key)
          ) {
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
      removeFilter,
      matchStationNamesBound,
      normalizeStationNameForLookup,
      normalizeStationNameForDisplay,
    ],
  );

  const [flyToTarget, setFlyToTarget] = useState(null);

  // When the header search selects a station, fly the map there and select it.
  useEffect(() => {
    if (!searchTarget) return;
    setFlyToTarget({ lat: searchTarget.flyTo.lat, lon: searchTarget.flyTo.lon, zoom: searchTarget.zoom });
    handleMarkerClick(searchTarget.stop);
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

  // For selected RegioJet routes, use GTFS timetable stops as marker source.
  // This keeps map stations aligned with GTFS details while preserving BoT fallback.
  useEffect(() => {
    if (!hasRouteFilter || !viewMapData) {
      setGtfsRouteFilterStops(null);
      return;
    }

    const activeId = String(selectedTrainRouteIds[0]);
    const activeRoute = Object.values(viewMapData).find(
      (r) => r?.route_id?.toString() === activeId,
    );
    if (!activeRoute) {
      setGtfsRouteFilterStops(null);
      return;
    }

    let filePath = null;
    if (checkRegioJetPrahaChop(activeRoute)) {
      filePath = "/data/gtfs/rjChopTimetable.json";
    } else if (checkRegioJetPrahaPrzemysl(activeRoute)) {
      filePath = "/data/gtfs/rjPremyslTimetable.json";
    }

    if (!filePath) {
      setGtfsRouteFilterStops(null);
      return;
    }

    let cancelled = false;
    const buildStopsFromGtfs = (json) => {
      const unique = new Map();
      (json?.trips || []).forEach((trip) => {
        (trip?.stops || []).forEach((stop) => {
          const key = `${stop.stopId || stop.name}-${stop.lat}-${stop.lon}`;
          if (!unique.has(key) && stop?.name && stop?.lat && stop?.lon) {
            unique.set(key, {
              stop_id: stop.name,
              stop_lat: stop.lat,
              stop_lon: stop.lon,
            });
          }
        });
      });
      return Array.from(unique.values());
    };

    const loadGtfsStops = async () => {
      try {
        if (gtfsStopsCacheRef.current.has(filePath)) {
          setGtfsRouteFilterStops(gtfsStopsCacheRef.current.get(filePath));
          return;
        }
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`Failed to load ${filePath}`);
        const json = await response.json();
        const mapped = buildStopsFromGtfs(json);
        gtfsStopsCacheRef.current.set(filePath, mapped);
        if (!cancelled) setGtfsRouteFilterStops(mapped);
      } catch {
        if (!cancelled) setGtfsRouteFilterStops(null);
      }
    };

    loadGtfsStops();
    return () => {
      cancelled = true;
    };
  }, [hasRouteFilter, selectedTrainRouteIds, viewMapData]);

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

    if (!cdTrainNumber) {
      setCdRouteFilterStops(null);
      return;
    }

    let cancelled = false;

    const buildStopsFromCD = (cdData) => {
      const trainData = cdData?.trains?.[cdTrainNumber];
      if (!trainData?.stops?.length) return null;

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
    filteredStops: cdRouteFilterStops || gtfsRouteFilterStops || routeFilterStops || filteredStops,
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
        const trainNumber =
          route.trip_short_name_0 || route.trip_short_name_1 || null;
        const segment = `${route.origin_trip_0 || "?"} → ${route.destination_trip_0 || "?"}`;
        return trainNumber ? `${trainNumber}: ${segment}` : `Route: ${segment}`;
      })()
    : selectedStationName || stopId;

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
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <MapClickHandler
          hasSelection={hasSelection}
          onClearFilter={handleFilterClose}
        />
        <MapViewportTracker onViewportChange={handleViewportChange} />
        <MapFlyController
          target={flyToTarget}
          onDone={() => setFlyToTarget(null)}
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
                      if (path.isFuture) {
                        return;
                      }
                      handlePolylineClick(path.routeId);
                    },
                  }}
                >
                  <Tooltip sticky>
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

                      const isDirectionOne = path.key.includes("-1-");
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
                      return path.isFuture
                        ? `${label} · opens ${formatFutureDate(path.futureStartDate)}`
                        : label;
                    })()}
                  </Tooltip>
                </Polyline>
                {/* Visual polyline — non-interactive, purely decorative */}
                <Polyline
                  key={`${path.key}-vis`}
                  positions={path.positions}
                  pathOptions={{
                    ...path.pathOptions,
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
        />
      </div>

      <TrainDetailPanel
        isOpen={isTrainDetailPanelOpen}
        onClose={closeTrainDetailPanel}
        tripsData={trips}
        viewMapData={viewMapData}
        selectedRouteIds={
          selectedTrainRouteIds?.filter(
            (id) => !shouldHideRouteDueToFutureDate(id, trips),
          ) ?? []
        }
      />
    </>
  );
};

export default TrainMap;
