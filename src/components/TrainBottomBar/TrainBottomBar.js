"use client";

import React, { useCallback } from "react";
import { buildRouteColorMap, NEUTRAL_FALLBACK_COLOR } from "../Map/utils/operatorColors";
import { normalizeStationNameForDisplay, abbreviateStationName } from "../Map/utils/stationNameUtils";
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
  if (isDetailPanelOpen) return null;
  if (!isOpen) return null;

  const hasBackOnTrackRoutes =
    !!stopRouteIds?.length && filteredViewMapData?.length > 0;

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

      // Filter via stations to only show stations in the selected city.
      // normalizeStationNameForDisplay handles local↔English equivalences (Wien→Vienna, etc.),
      // with a substring fallback for cities not in the known list.
      let viaText = "";
      if (viaStationsRaw && selectedNormalizedName) {
        const viaList = viaStationsRaw.split(" - ");
        const filteredVia = viaList.filter((station) => {
          const normalizedVia = normalizeStationNameForDisplay(station.trim());
          return (
            normalizedVia === selectedNormalizedName ||
            station.toLowerCase().includes(selectedNormalizedName.toLowerCase())
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
      className="absolute bottom-bar-scroll-fade bottom-0 w-full h-12 pb-[env(safe-area-inset-bottom,0px)] md:h-auto md:max-h-7 md:pb-0 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.1)] z-[1000] overflow-y-hidden overflow-x-scroll p-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
    >
      <div className="flex min-w-max p-1">
        {!hasBackOnTrackRoutes ? (
          <div className="flex items-center h-10 px-4 text-sm text-gray-500 italic">
            No night train routes found for this station.
          </div>
        ) : (
        Array.from(routeMap.values()).map((route, index) => {
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
              onFocus={() => {
                // Focus preview only on fine pointers (desktop keyboard).
                if (
                  typeof window !== "undefined" &&
                  window.matchMedia("(hover: hover) and (pointer: fine)").matches
                ) {
                  onRouteHover?.(route.routeId);
                }
              }}
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
                <strong>{abbreviateStationName(route.origin)}</strong>
                &nbsp;-&nbsp;
                {route.viaText ? <span>({abbreviateStationName(route.viaText)})</span> : null}
                {route.viaText && <>&nbsp;-&nbsp;</>}
                <strong>{abbreviateStationName(route.destination)}</strong>
              </div>
            </div>
          );
        })
        )}
      </div>
    </div>
  );
};

export default TrainBottomBar;
