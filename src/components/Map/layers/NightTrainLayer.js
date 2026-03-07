"use client";

import React, { memo } from "react";
import Leaflet from "leaflet";
import { Marker, Polyline, Tooltip } from "react-leaflet";
import { StationTooltipContent } from "../utils/stationTooltip";
import { createMapIcons } from "../utils/mapIcons";
import { normalizeStationNameForDisplay } from "../utils/stationNameUtils";

// Re-use the same icons as Back-on-Track markers so NightTrain and Back-on-Track stations
// look identical. This also avoids creating new DivIcon instances for every marker.
const {
  defaultIcon: nightTrainDefaultIcon,
  selectedIcon: nightTrainSelectedIcon,
  viaIcon: nightTrainViaIcon,
} = createMapIcons(Leaflet);

/**
 * Renders NightJet or EuroNight stations and route polylines.
 * Memoized so toggling "Show all routes" doesn't re-render these heavy layers.
 */
export const NightTrainStationMarkers = memo(function NightTrainStationMarkers({
  stations,
  endpointStations,
  hideIntermediateStations,
  isGrouped,
  backOnTrackCityNames,
  stationKeyPrefix,
  markerClassName,
  stops,
  matchStationNames,
  onMarkerClick,
  selected,
  stopId,
}) {
  let toRender = stations ?? [];
  if (hideIntermediateStations) {
    toRender = toRender.filter((s) => {
      if (!s?.name && !s?.id) return false;
      return (
        endpointStations.has(s.name) || (s.id && endpointStations.has(s.id))
      );
    });
  }

  if (isGrouped && toRender.length > 0) {
    const cityGroups = new Map();

    toRender.forEach((s) => {
      const lat = s?.location?.latitude;
      const lon = s?.location?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const rawName = s.name || s.id;
      if (!rawName) return;

      const cityName = normalizeStationNameForDisplay(rawName);
      const key = cityName || rawName;

      if (!cityGroups.has(key)) {
        cityGroups.set(key, []);
      }
      cityGroups.get(key).push(s);
    });

    const grouped = [];

    cityGroups.forEach((stationsInCity, cityKey) => {
      if (stationsInCity.length === 1) {
        grouped.push(stationsInCity[0]);
        return;
      }

      const mainStation =
        stationsInCity.find((station) => {
          const name = String(station.name || "").toLowerCase();
          return (
            name.includes("centraal") ||
            name.includes("central") ||
            name.includes("hbf") ||
            name.includes("hauptbahnhof")
          );
        }) || stationsInCity[0];

      // If any station in the group is a route start/end, show the main marker as destination (endpoint).
      // Use matchStationNames so we match name variants (e.g. "Wien Hbf" vs "Wien Hauptbahnhof").
      const isEndpoint = stationsInCity.some((st) => {
        const name = st?.name || st?.id;
        if (!name) return false;
        if (endpointStations.has(name) || (st.id && endpointStations.has(st.id)))
          return true;
        return Array.from(endpointStations).some((ep) => matchStationNames(name, ep));
      });

      grouped.push({
        ...mainStation,
        isGrouped: true,
        groupSize: stationsInCity.length,
        groupedStations: stationsInCity,
        displayName: cityKey,
        isEndpoint,
      });
    });

    // If Back-on-Track markers already provide a grouped city marker,
    // avoid drawing an additional NightJet/EuroNight marker for the same city.
    if (backOnTrackCityNames && backOnTrackCityNames.size > 0) {
      toRender = grouped.filter((station) => {
        const rawCity = station.displayName || station.name;
        if (!rawCity) return true;
        const normalizedCity = normalizeStationNameForDisplay(rawCity);
        return !backOnTrackCityNames.has(normalizedCity);
      });
    } else {
      toRender = grouped;
    }
  }

  return toRender.map((s, idx) => {
    const lat = s?.location?.latitude;
    const lon = s?.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    // Endpoint = route starts or ends here. For grouped markers, use isEndpoint set from any station in the group.
    // Also match by name variant (e.g. "Wien Hbf" vs "Wien Hauptbahnhof") using matchStationNames.
    const isEnd =
      s.isEndpoint === true ||
      endpointStations.has(s.name) ||
      (s.id && endpointStations.has(s.id)) ||
      (s.name &&
        Array.from(endpointStations).some((ep) => matchStationNames(s.name, ep)));
    const isSelected = selected && stopId && matchStationNames(s.name, stopId);
    // Same visual style and selection color as Back-on-Track markers:
    // - selected station: orange dot
    // - endpoint: blue dot
    // - intermediate: green via dot
    const icon = isSelected
      ? nightTrainSelectedIcon
      : isEnd
        ? nightTrainDefaultIcon
        : nightTrainViaIcon;

    return (
      <Marker
        key={`${stationKeyPrefix}-${idx}-${s.id || s.name}`}
        position={[lat, lon]}
        icon={icon}
        eventHandlers={{
          click: (e) => {
            e.originalEvent?.stopPropagation();
            const matchingStop = stops?.find(
              (stop) =>
                matchStationNames(s.name, stop.stop_id) ||
                matchStationNames(s.name, stop.stop_name),
            );
            const filteredStop = {
              ...(matchingStop || {}),
              stop_id: s.name,
              stop_name: s.name,
              displayName: s.name, // Same shape as useMapMarkers so handleMarkerClick / tooltips behave identically.
              stop_lat: lat,
              stop_lon: lon,
              isGrouped: false,
            };
            onMarkerClick(filteredStop);
          },
        }}
      >
        {/* All-stations view: name only (no route selected); same pattern as polyline stations */}
        <Tooltip
          direction="top"
          offset={[0, -10]}
          opacity={1}
          permanent={false}
        >
          <StationTooltipContent
            name={s.displayName || s.name}
            showTimes={false}
          />
        </Tooltip>
      </Marker>
    );
  });
});

/**
 * Renders route polylines and optionally stations along the route.
 * Memoized so toggling "Show all routes" doesn't re-render these heavy layers.
 */
export const NightTrainPolylines = memo(function NightTrainPolylines({
  overlays,
  selectedOverlay,
  overlayType,
  onPolylineClick,
  onRouteStationClick,
  stops,
  matchStationNames,
  hideIntermediateStations,
  stationKeyPrefix,
  markerClassName,
  selected,
  stopId,
}) {
  const list =
    selectedOverlay && selectedOverlay.type === overlayType
      ? [selectedOverlay]
      : overlays;

  return (
    <>
      {list.map((ov) => (
        <React.Fragment key={`poly-${ov.key}`}>
          <Polyline
            positions={ov.coords}
            pathOptions={{
              color: ov.color,
              weight: 4.5,
              opacity: 0.8,
              lineCap: "round",
              lineJoin: "round",
              cursor: "pointer",
            }}
            eventHandlers={{
              click: (e) => {
                e.originalEvent.stopPropagation();
                onPolylineClick(ov);
              },
            }}
          >
            {!selectedOverlay && (
              <Tooltip sticky>
                {ov.lineName}: {ov.stations?.[0]?.name} →{" "}
                {ov.stations?.[ov.stations?.length - 1]?.name}
              </Tooltip>
            )}
          </Polyline>
          {(ov.stations || []).map((s, idx) => {
            if (hideIntermediateStations) {
              const isEnd = idx === 0 || idx === (ov.stations?.length ?? 0) - 1;
              if (!isEnd) return null;
            }
            const lat = s?.location?.latitude;
            const lon = s?.location?.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const isEnd = idx === 0 || idx === (ov.stations?.length ?? 0) - 1;
            const isSelected =
              selected && stopId && matchStationNames(s.name, stopId);
            // Same visual style and selection color as Back-on-Track markers.
            const icon = isSelected
              ? nightTrainSelectedIcon
              : isEnd
                ? nightTrainDefaultIcon
                : nightTrainViaIcon;
            return (
              <Marker
                key={`${stationKeyPrefix}-${ov.key}-${idx}-${s.id || s.name}`}
                position={[lat, lon]}
                icon={icon}
                eventHandlers={{
                  click: (e) => {
                    e.originalEvent?.stopPropagation();
                    const matchingStop = stops?.find(
                      (stop) =>
                        matchStationNames(s.name, stop.stop_id) ||
                        matchStationNames(s.name, stop.stop_name),
                    );
                    // Same shape as useMapMarkers: always call handler so behavior matches (bottom bar, filter).
                    const filteredStop = matchingStop ?? {
                      stop_id: s.name,
                      stop_name: s.name,
                      displayName: s.name,
                      stop_lat: lat,
                      stop_lon: lon,
                      isGrouped: false,
                    };
                    onRouteStationClick(filteredStop);
                  },
                }}
              >
                {/* Route stations: name always; Dep/Arr only when specific route selected */}
                <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                  <StationTooltipContent
                    name={s.name}
                    departure={s.departure}
                    arrival={s.arrival}
                    showTimes={!!selectedOverlay}
                  />
                </Tooltip>
              </Marker>
            );
          })}
        </React.Fragment>
      ))}
    </>
  );
});
