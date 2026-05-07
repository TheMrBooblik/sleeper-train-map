"use client";

import React, { useCallback } from "react";
import { buildRouteColorMap, NEUTRAL_FALLBACK_COLOR } from "../Map/utils/operatorColors";
import { normalizeStationNameForDisplay } from "../Map/utils/stationNameUtils";
import { shouldHideRouteDueToFutureDate } from "../Map/utils/routeStyleUtils";

/**
 * Bottom bar showing routes (Back-on-Track + NightJet/EuroNight) for the selected station.
 * Hidden when TrainDetailPanel is open.
 */
const TrainBottomBar = ({
  isOpen,
  sidebarDisabled,
  stopId,
  stopRouteIds,
  selectedNormalizedName,
  isDetailPanelOpen = false,
  onRouteClick,
  onRouteHover,
  onRouteLeave,
  viewMapData,
  trips,
}) => {
  const hideRoute = useCallback(
    (routeId) => shouldHideRouteDueToFutureDate(routeId, trips),
    [trips],
  );

  // Guard against undefined viewMapData; hide future "From …" and outside service_id seasons.
  const filteredViewMapData = viewMapData
    ? Object.values(viewMapData).filter((el) => {
        const routeId = el?.route_id?.toString();
        return stopRouteIds?.includes(routeId) && !hideRoute(routeId);
      })
    : [];

  if (sidebarDisabled) return null;
  // Hide when train detail panel is open
  if (isDetailPanelOpen) return null;
  // Show bar when we have Back-on-Track routes for this station
  const hasBackOnTrackRoutes =
    !!stopRouteIds?.length && filteredViewMapData?.length > 0;
  if (!hasBackOnTrackRoutes) return null;

  // Build operator-based color map for these routes (brand colors with shade variation)
  const routeIds = filteredViewMapData.map((el) => el?.route_id?.toString()).filter(Boolean);
  const routeDataMap = new Map();
  filteredViewMapData.forEach((el) => {
    if (el?.route_id) routeDataMap.set(el.route_id.toString(), el);
  });
  const routeColorMap = buildRouteColorMap(routeIds, routeDataMap);

  // Group routes by origin-destination to avoid duplicates
  // Store route_id to determine color
  const routeMap = new Map();

  filteredViewMapData?.forEach((el) => {
    let stationArr = [el?.origin_trip_0, el?.destination_trip_0];
    stationArr.sort();

    const routeKey = `${stationArr[0]}-${stationArr[1]}`;

    if (!routeMap.has(routeKey)) {
      // Get the via stations
      const viaStationsRaw = stationArr[1] === stopId ? el?.via_1 : el?.via_0;

      // Filter via stations to only show stations in the selected city (e.g., Milan)
      let viaText = "";
      if (viaStationsRaw && selectedNormalizedName) {
        const viaList = viaStationsRaw.split(" - ");

        // Create a set of all possible name variations for the selected city
        const cityVariations = new Set(
          [
            selectedNormalizedName.toLowerCase(),
            selectedNormalizedName === "Milan" ? "milano" : null,
            selectedNormalizedName === "Torino" ? "turin" : null,
            selectedNormalizedName === "Vienna" ? "wien" : null,
            selectedNormalizedName === "Rome" ? "roma" : null,
            selectedNormalizedName === "Munich" ? "münchen" : null,
            selectedNormalizedName === "Cologne" ? "köln" : null,
            selectedNormalizedName === "Zurich" ? "zürich" : null,
            selectedNormalizedName === "Brussels" ? "bruxelles" : null,
            selectedNormalizedName === "Antwerpen" ? "antwerpen" : null,
          ].filter(Boolean),
        );

        const filteredVia = viaList.filter((station) => {
          const stationLower = station.toLowerCase();
          return Array.from(cityVariations).some((cityName) =>
            stationLower.includes(cityName),
          );
        });

        if (filteredVia.length > 0) {
          viaText = filteredVia.join(" - ");
        }
      }

      routeMap.set(routeKey, {
        origin: stationArr[0],
        destination: stationArr[1],
        viaText: viaText,
        routeId: el?.route_id?.toString(), // Store route_id for color determination
        routeData: el, // Keep source route data for special color rules (e.g. RegioJet)
      });
    }
  });

  return (
    <div
      className={`absolute bottom-bar-scroll-fade ${isOpen ? "bottom-0" : "-bottom-[100px]"} w-full h-12 md:h-auto md:max-h-7 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.1)] z-[1000] overflow-y-hidden overflow-x-scroll transition-[bottom] duration-300 p-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]`}
    >
      <div className="flex p-1">
        {/* Back-on-Track routes */}
        {Array.from(routeMap.values()).map((route, index) => {
          // Operator brand color (with shade variation for same-operator routes)
          const routeColor =
            routeColorMap.get(route.routeId) || NEUTRAL_FALLBACK_COLOR;

          return (
            <div
              className="relative flex items-center h-10 md:h-auto pl-2 pr-3 whitespace-nowrap text-sm cursor-pointer hover:bg-gray-100 active:bg-gray-100 md:active:bg-transparent transition-colors"
              key={`route-info-${index}`}
              role="button"
              tabIndex={0}
              onClick={() => onRouteClick?.(route.routeId)}
              onMouseEnter={() => onRouteHover?.(route.routeId)}
              onMouseLeave={() => onRouteLeave?.()}
              onFocus={() => onRouteHover?.(route.routeId)}
              onBlur={() => onRouteLeave?.()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRouteClick?.(route.routeId);
                }
              }}
            >
              {/* Color indicator line */}
              <div
                className="absolute left-0 top-0.5 bottom-0.5 w-1 rounded shrink-0"
                style={{ backgroundColor: routeColor }}
              />
              <div className="flex items-center">
                <strong>{route.origin}</strong>
                &nbsp;-&nbsp;
                {route.viaText ? <span>({route.viaText})</span> : null}
                {route.viaText && <>&nbsp;-&nbsp;</>}
                <strong>{route.destination}</strong>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TrainBottomBar;
