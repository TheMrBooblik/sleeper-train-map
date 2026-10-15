"use client";

import React, { useMemo, useRef } from "react";
import Leaflet from "leaflet";
import { Marker, Tooltip } from "react-leaflet";
import { groupCityMarkers } from "../utils/groupCityMarkers";
import { StationTooltipContent } from "../utils/stationTooltip";
import {
  shouldHideRouteDueToFutureDate,
  upcomingPreviewRouteIds,
  selectedRoutesWithLines,
} from "../utils/routeStyleUtils";
import { createMapIcons, stationHitSize } from "../utils/mapIcons";
import { thinStationsByViewport } from "../utils/thinStationsByViewport";
import { alwaysShowStations } from "../../../data/alwaysShowStations";

/**
 * Hook: builds Back-on-Track station markers (grouped or not, with correct icons).
 * Returns array of Marker elements for the map.
 */
export function useMapMarkers({
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
  routeFilteredMode = false,
  mapZoom = null,
  mapBounds = null,
}) {
  const { defaultIcon, selectedIcon, viaIcon, futureIcon } = useMemo(
    () => createMapIcons(Leaflet),
    [],
  );
  // Grouped markers build their icon inline below, so they need the same size.
  const hitSize = useMemo(() => stationHitSize(), []);
  const previousZoomRef = useRef(null);
  const previousVisibleStopKeysRef = useRef(new Set());

  const getStopKey = (stop) =>
    `${stop?.stop_id || ""}|${stop?.stop_lat || ""}|${stop?.stop_lon || ""}`;

  return useMemo(() => {
    let stopsToShow = [];
    let hiddenStops = [];

    // Two different "not running today", and they want opposite treatment.
    //
    // A season that has already PASSED is gone: its stops are dropped, as they
    // always have been. A period that has not BEGUN is a preview whose line is
    // deliberately drawn (tickets are on sale), so dropping its stops left the
    // December Brussels–Milan routing running visibly through Eindhoven and
    // Breda with no markers on it. Those stops stay, faded — see futureIcon.
    const upcomingPreviews = upcomingPreviewRouteIds(viewMapData);
    const isUpcomingPreview = (routeId) => upcomingPreviews.has(String(routeId));
    const seasonHasPassed = (routeId, route) =>
      shouldHideRouteDueToFutureDate(routeId, trips, route) &&
      !isUpcomingPreview(routeId);

    if (hideIntermediateStations && viewMapData) {
      if (!filteredStops?.length) return [];
      const nightTrainStationIds = new Set();
      Object.values(viewMapData).forEach((route) => {
        if (route?.route_id && seasonHasPassed(route.route_id, route)) return;
        if (route) {
          [
            route.origin_trip_0,
            route.destination_trip_0,
            route.origin_trip_1,
            route.destination_trip_1,
            route.via_0,
            route.via_1,
          ]
            .filter(Boolean)
            .forEach((name) => {
              nightTrainStationIds.add(name);
              nightTrainStationIds.add(normalizeStationNameForLookup(name));
            });
        }
      });
      stopsToShow = filteredStops.filter((stop) => {
        if (!stop?.stop_id) return false;
        const n = normalizeStationNameForLookup(stop.stop_id);
        return (
          nightTrainStationIds.has(stop.stop_id) || nightTrainStationIds.has(n)
        );
      });
    } else {
      if (!filteredStops?.length) return [];
      stopsToShow = filteredStops;
    }

    // In normal mode, show only stations that have at least one BoT route.
    // In route-filter mode, allow GTFS-derived stations even when city metadata is missing.
    if (!routeFilteredMode) {
      stopsToShow = stopsToShow.filter((stop) => {
        if (!stop?.stop_id) return false;
        const n = normalizeStationNameForLookup(stop.stop_id);
        const cityInfo = cities[n] || cities[stop.stop_id];
        if (!cityInfo?.stop_route_ids) return false;
        const routeIds = cityInfo.stop_route_ids
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        return routeIds.some(
          (routeId) => !seasonHasPassed(routeId, viewMapData?.[routeId]),
        );
      });
    }

    const skipSet = new Set();
    stationsToSkip.forEach((name) => {
      skipSet.add(name);
      skipSet.add(normalizeStationNameForLookup(name));
    });
    stopsToShow = stopsToShow.filter((stop) => {
      if (!stop?.stop_id) return false;
      const n = normalizeStationNameForLookup(stop.stop_id);
      return !skipSet.has(stop.stop_id) && !skipSet.has(n);
    });

    // With a station selected, a stop belongs on the map only if one of the
    // selected routes that DRAWS a line calls there. The season filter above
    // asks whether any route at the stop still runs, selected or not, so a
    // closed selected route kept its stops as dots with no line through them.
    // Filtered before grouping, so a grouped marker cannot anchor on one.
    const liveSelectedRouteIds =
      selected && stopRouteIds?.length > 0
        ? selectedRoutesWithLines(stopRouteIds, trips, viewMapData)
        : null;
    if (!routeFilteredMode && liveSelectedRouteIds) {
      stopsToShow = stopsToShow.filter((stop) => {
        const n = normalizeStationNameForLookup(stop.stop_id);
        const cityInfo = cities[n] || cities[stop.stop_id];
        return (cityInfo?.stop_route_ids || "")
          .split(",")
          .some((id) => liveSelectedRouteIds.has(id.trim()));
      });
    }

    // Keep zoom-thinning narrowly scoped:
    // - only in normal station mode
    // - only when intermediate stations are not already hidden
    if (!routeFilteredMode && !hideIntermediateStations) {
      // Start/end stations of visible routes should never disappear on zoomed-out views.
      const routeEndpointStations = [];
      if (viewMapData) {
        Object.values(viewMapData).forEach((route) => {
          if (route?.route_id && seasonHasPassed(route.route_id, route)) return;
          [
            route?.origin_trip_0,
            route?.destination_trip_0,
            route?.origin_trip_1,
            route?.destination_trip_1,
          ]
            .filter(Boolean)
            .forEach((name) => routeEndpointStations.push(name));
        });
      }

      const thinningResult = thinStationsByViewport({
        stops: stopsToShow,
        cities,
        mapZoom,
        mapBounds,
        normalizeStationNameForLookup,
        alwaysShowStations: [...alwaysShowStations, ...routeEndpointStations],
        selectedStopId: stopId,
      });
      let nextVisibleStops = thinningResult.visibleStops;
      let nextHiddenStops = thinningResult.hiddenStops;

      // On zoom-in, preserve previously visible "big" stations.
      // This avoids swapping one big station for another.
      const previousZoom = previousZoomRef.current;
      const isZoomingIn =
        typeof mapZoom === "number" &&
        typeof previousZoom === "number" &&
        mapZoom > previousZoom;

      if (isZoomingIn && previousVisibleStopKeysRef.current.size > 0) {
        const visibleByKey = new Map(
          nextVisibleStops.map((stop) => [getStopKey(stop), stop]),
        );
        const hiddenByKey = new Map(
          nextHiddenStops.map((stop) => [getStopKey(stop), stop]),
        );

        previousVisibleStopKeysRef.current.forEach((key) => {
          if (visibleByKey.has(key)) return;
          const previouslyVisibleStop = hiddenByKey.get(key);
          if (previouslyVisibleStop) {
            visibleByKey.set(key, previouslyVisibleStop);
            hiddenByKey.delete(key);
          }
        });

        nextVisibleStops = Array.from(visibleByKey.values());
        nextHiddenStops = Array.from(hiddenByKey.values());
      }

      stopsToShow = nextVisibleStops;
      hiddenStops = nextHiddenStops;
    }

    previousZoomRef.current = mapZoom;
    previousVisibleStopKeysRef.current = new Set(stopsToShow.map(getStopKey));

    if (!stopsToShow.length) return [];

    // GTFS route-filter markers may not exist in Back-on-Track city metadata.
    // Keep them visible by disabling city-grouping in this mode.
    let groupedStops = groupCityMarkers(
      stopsToShow,
      cities,
      routeFilteredMode ? false : isGrouped,
      normalizeStationNameForDisplay,
      normalizeStationNameForLookup,
    );

    const routeIdMap = new Map();
    const normalizedNameCache = new Map();
    if (selected && stopRouteIds?.length > 0 && viewMapData) {
      Object.values(viewMapData).forEach((route) => {
        if (route?.route_id) {
          routeIdMap.set(route.route_id.toString(), route);
        }
      });
    }
    const getCachedNormalizedName = (name) => {
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    const visibleMarkers = groupedStops
      .map((filteredStop, index) => {
        const isSelected = filteredStop.isGrouped
          ? filteredStop.groupedStations?.some((s) => s.stop_id === stopId)
          : stopId === filteredStop?.stop_id;
        const stopLat = filteredStop?.stop_lat;
        const stopLon = filteredStop?.stop_lon;
        const { stop_id } = filteredStop;
        const normalizedStopId = getCachedNormalizedName(stop_id);
        const cityInfo = cities[normalizedStopId] || cities[stop_id];
        const { stop_route_ids } = cityInfo || {};

        if (!stopLat || !stopLon) return null;
        if (!routeFilteredMode && (!stop_route_ids || !cityInfo)) return null;

        // This filter is Back-on-Track specific (requires city.stop_route_ids).
        // In routeFilteredMode we may render GTFS-only stations without this field.
        if (!routeFilteredMode && liveSelectedRouteIds) {
          const stationRouteIds = (stop_route_ids || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          const isPartOfSelectedRoutes = stationRouteIds.some((id) =>
            liveSelectedRouteIds.has(id),
          );
          if (!isPartOfSelectedRoutes) return null;
        }

        let isViaStationForFilteredRoutes = !!cityInfo?.isViaStation;
        if (liveSelectedRouteIds && !isSelected) {
          const stationsToCheck =
            filteredStop.isGrouped && filteredStop.groupedStations
              ? filteredStop.groupedStations.map((s) => s.stop_id)
              : [stop_id];
          // Only a drawn route can make this stop an endpoint on screen.
          const isOriginOrDestination = [...liveSelectedRouteIds].some((routeId) => {
            const route = routeIdMap.get(routeId);
            if (!route) return false;
            const routeStations = [
              route.origin_trip_0,
              route.destination_trip_0,
              route.origin_trip_1,
              route.destination_trip_1,
            ].filter(Boolean);
            return stationsToCheck.some((stationId) => {
              const nId = getCachedNormalizedName(stationId);
              return routeStations.some((rs) => {
                const nRs = getCachedNormalizedName(rs);
                return (
                  rs === stationId ||
                  nRs === nId ||
                  nRs === stationId ||
                  rs === nId
                );
              });
            });
          });
          isViaStationForFilteredRoutes = !isOriginOrDestination;
        }

        // Every route calling here is a period that has not begun — the station
        // exists on the map only because of a preview. Fade it to match the
        // line drawn through it. A selected station keeps its own icon: the
        // user pointed at it, and the panel says which timetable it belongs to.
        const callingRouteIds = (stop_route_ids || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        const onlyUpcoming =
          !routeFilteredMode &&
          !isSelected &&
          callingRouteIds.length > 0 &&
          callingRouteIds.every(isUpcomingPreview);

        let iconToUse = defaultIcon;
        if (isSelected) iconToUse = selectedIcon;
        else if (onlyUpcoming) iconToUse = futureIcon;
        else if (isViaStationForFilteredRoutes) iconToUse = viaIcon;

        if (filteredStop.isGrouped) {
          const isViaGroup = !isSelected && isViaStationForFilteredRoutes;
          let bgGradient, shadow;
          if (isSelected) {
            bgGradient = "linear-gradient(135deg, #FF9800, #F57C00)";
            shadow = "0 3px 8px rgba(255, 152, 0, 0.6)";
          } else if (isViaGroup) {
            bgGradient = "linear-gradient(135deg, #4CAF50, #388E3C)";
            shadow = "0 3px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2)";
          } else {
            bgGradient = "linear-gradient(135deg, #2196F3, #1976D2)";
            shadow = "0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2)";
          }
          const groupIcon = new Leaflet.DivIcon({
            className: isSelected
              ? "grouped-station-dot selected"
              : "grouped-station-dot",
            // Hit area around the 20px visual dot — wide on touch, tight for a
            // mouse (same pointer-aware size as createMapIcons).
            html: `<div style="width:${hitSize}px;height:${hitSize}px;display:flex;align-items:center;justify-content:center;cursor:pointer;">
              <div style="width:20px;height:20px;background:${bgGradient};border-radius:50%;border:3px solid var(--station-ring, white);box-shadow:${shadow};transition:all 0.3s ease;z-index:1000;position:relative;">
              <div style="position:absolute;top:-8px;left:-8px;background:linear-gradient(135deg,#FF9800,#F57C00);color:white;border-radius:50%;width:16px;height:16px;font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:bold;border:2px solid var(--station-ring, white);box-shadow:0 2px 6px rgba(255,152,0,0.5);z-index:2000;">
                ${filteredStop.groupSize}
              </div>
            </div></div>`,
            iconSize: [hitSize, hitSize],
            iconAnchor: [hitSize / 2, hitSize / 2],
          });
          iconToUse = groupIcon;
        }

        return (
          <Marker
            key={filteredStop?.stop_id || `marker-${index}`}
            position={[stopLat, stopLon]}
            icon={iconToUse}
            eventHandlers={{
              click: () => handleMarkerClick(filteredStop),
            }}
          >
            {/* Same tooltip pattern as night-train stations: name only (no route-specific times for Back-on-Track markers) */}
            <Tooltip
              direction="top"
              offset={[0, -10]}
              opacity={1}
              // Avoid tooltips getting "stuck" when the pointer leaves the marker.
              // Leaflet keeps the tooltip visible longer when it is interactive/sticky.
              interactive={false}
              sticky={false}
              permanent={false}
            >
              <StationTooltipContent
                name={filteredStop.displayName || stop_id}
                showTimes={false}
                note={onlyUpcoming ? "Not yet running" : null}
              />
            </Tooltip>
          </Marker>
        );
      })
      .filter(Boolean);

    // We no longer render one Leaflet Marker per "thinned away" station (small green
    // dots). At low zoom that was hundreds of extra markers and noticeably slowed pan/zoom.
    return visibleMarkers;
  }, [
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
    routeFilteredMode,
    mapZoom,
    mapBounds,
    defaultIcon,
    selectedIcon,
    viaIcon,
    futureIcon,
    hitSize,
  ]);
}
