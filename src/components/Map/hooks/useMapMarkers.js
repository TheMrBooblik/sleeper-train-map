"use client";

import React, { useMemo } from "react";
import Leaflet from "leaflet";
import { Marker, Tooltip } from "react-leaflet";
import { groupCityMarkers } from "../utils/groupCityMarkers";
import { StationTooltipContent } from "../utils/stationTooltip";
import { shouldHideRouteDueToFutureDate } from "../utils/routeStyleUtils";
import { createMapIcons } from "../utils/mapIcons";

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
}) {
  const { defaultIcon, selectedIcon, viaIcon } = useMemo(
    () => createMapIcons(Leaflet),
    [],
  );

  return useMemo(() => {
    let stopsToShow = [];

    if (hideIntermediateStations && viewMapData) {
      if (!filteredStops?.length) return [];
      const nightTrainStationIds = new Set();
      Object.values(viewMapData).forEach((route) => {
        if (
          route?.route_id &&
          shouldHideRouteDueToFutureDate(route.route_id.toString(), trips)
        ) {
          return;
        }
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
        return nightTrainStationIds.has(stop.stop_id) || nightTrainStationIds.has(n);
      });
    } else {
      if (!filteredStops?.length) return [];
      stopsToShow = filteredStops;
    }

    // Only show stations that have at least one route (in cities with stop_route_ids).
    stopsToShow = stopsToShow.filter((stop) => {
      if (!stop?.stop_id) return false;
      const n = normalizeStationNameForLookup(stop.stop_id);
      const cityInfo = cities[n] || cities[stop.stop_id];
      return !!(cityInfo?.stop_route_ids);
    });

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

    if (!stopsToShow.length) return [];

    const groupedStops = groupCityMarkers(
      stopsToShow,
      cities,
      isGrouped,
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

    return groupedStops
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

        if (!stopLat || !stopLon || !stop_route_ids || !cityInfo) return null;

        if (selected && stopRouteIds?.length > 0) {
          const stationRouteIds = stop_route_ids.split(",").map((id) => id.trim()).filter(Boolean);
          const isPartOfSelectedRoutes = stationRouteIds.some((id) =>
            stopRouteIds.includes(id),
          );
          if (!isPartOfSelectedRoutes) return null;
        }

        let isViaStationForFilteredRoutes = cityInfo.isViaStation;
        if (
          selected &&
          stopRouteIds?.length > 0 &&
          !isSelected
        ) {
          const stationsToCheck =
            filteredStop.isGrouped && filteredStop.groupedStations
              ? filteredStop.groupedStations.map((s) => s.stop_id)
              : [stop_id];
          const isOriginOrDestination = stopRouteIds.some((routeId) => {
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

        let iconToUse = defaultIcon;
        if (isSelected) iconToUse = selectedIcon;
        else if (isViaStationForFilteredRoutes) iconToUse = viaIcon;

        if (filteredStop.isGrouped) {
          const bgGradient = isSelected
            ? "linear-gradient(135deg, #FF9800, #F57C00)"
            : "linear-gradient(135deg, #2196F3, #1976D2)";
          const groupIcon = new Leaflet.DivIcon({
            className: isSelected ? "grouped-station-dot selected" : "grouped-station-dot",
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
            <Tooltip direction="top" offset={[0, -10]} opacity={1}>
              <StationTooltipContent
                name={filteredStop.displayName || stop_id}
                showTimes={false}
              />
            </Tooltip>
          </Marker>
        );
      })
      .filter(Boolean);
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
    defaultIcon,
    selectedIcon,
    viaIcon,
  ]);
}
