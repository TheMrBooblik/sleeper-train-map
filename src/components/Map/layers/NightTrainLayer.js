"use client";

import React from "react";
import Leaflet from "leaflet";
import { Marker, Polyline, Tooltip } from "react-leaflet";
import { StationTooltipContent } from "../utils/stationTooltip";

/**
 * Renders NightJet or EuroNight stations and route polylines.
 * Used when line filter is inactive (all stations) or for the selected overlay type.
 */
export function NightTrainStationMarkers({
  stations,
  endpointStations,
  hideIntermediateStations,
  stationKeyPrefix,
  markerClassName,
  stops,
  matchStationNames,
  onMarkerClick,
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

  return toRender.map((s, idx) => {
    const lat = s?.location?.latitude;
    const lon = s?.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const isEnd =
      endpointStations.has(s.name) || (s.id && endpointStations.has(s.id));
    const icon = new Leaflet.DivIcon({
      className: markerClassName,
      html: isEnd
        ? '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>'
        : '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
      iconSize: isEnd ? [20, 20] : [14, 14],
      iconAnchor: isEnd ? [10, 10] : [7, 7],
    });

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
              stop_lat: lat,
              stop_lon: lon,
              isGrouped: false,
            };
            onMarkerClick(filteredStop);
          },
        }}
      >
        {/* All-stations view: name only (no route selected); same pattern as polyline stations */}
        <Tooltip direction="top" offset={[0, -10]} opacity={1} permanent={false}>
          <StationTooltipContent name={s.name} showTimes={false} />
        </Tooltip>
      </Marker>
    );
  });
}

/**
 * Renders route polylines and optionally stations along the route.
 */
export function NightTrainPolylines({
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
                {ov.lineName} {ov.stations?.[0]?.name} -{" "}
                {ov.stations?.[ov.stations?.length - 1]?.name}
              </Tooltip>
            )}
          </Polyline>
          {(ov.stations || []).map((s, idx) => {
            if (hideIntermediateStations) {
              const isEnd =
                idx === 0 || idx === (ov.stations?.length ?? 0) - 1;
              if (!isEnd) return null;
            }
            const lat = s?.location?.latitude;
            const lon = s?.location?.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const isEnd =
              idx === 0 || idx === (ov.stations?.length ?? 0) - 1;
            const icon = new Leaflet.DivIcon({
              className: markerClassName,
              html: isEnd
                ? '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>'
                : '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
              iconSize: isEnd ? [20, 20] : [14, 14],
              iconAnchor: isEnd ? [10, 10] : [7, 7],
            });
            return (
              <Marker
                key={`${stationKeyPrefix}-${ov.key}-${idx}-${s.id || s.name}`}
                position={[lat, lon]}
                icon={icon}
                eventHandlers={{
                  click: () => {
                    const matchingStop = stops?.find(
                      (stop) =>
                        matchStationNames(s.name, stop.stop_id) ||
                        matchStationNames(s.name, stop.stop_name),
                    );
                    if (matchingStop) onRouteStationClick(matchingStop);
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
}
