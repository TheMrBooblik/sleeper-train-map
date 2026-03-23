"use client";

import React, { useCallback } from "react";
import { useViewMap } from "../../hooks/requests/useViewMap";
import { useTrips } from "../../hooks/requests/useTrips";
import { ROUTE_COLORS } from "../Map/constants";
import { normalizeStationNameForDisplay } from "../Map/utils/stationNameUtils";

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
}) => {
  const { viewMapData } = useViewMap();
  const { trips } = useTrips();

  // Helper function to check if a route should be filtered out due to future "From <Date>" note
  const shouldHideRouteDueToFutureDate = useCallback(
    (routeId) => {
      if (!trips || !routeId) return false;

      // Find all trips for this route
      const routeTrips = Object.values(trips).filter(
        (trip) => trip.route_id?.toString() === routeId.toString(),
      );

      if (routeTrips.length === 0) return false;

      // Check if any trip has a "From <Date>" note with a future date
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Reset to start of day for comparison

      for (const trip of routeTrips) {
        const irregularities = trip.irregularities;
        if (!irregularities || typeof irregularities !== "string") continue;

        // Match "From YYYY-MM-DD" pattern (case-insensitive, flexible spacing)
        const fromDateMatch = irregularities.match(
          /From\s+(\d{4}-\d{2}-\d{2})/i,
        );
        if (fromDateMatch) {
          const fromDateStr = fromDateMatch[1];
          const fromDate = new Date(fromDateStr);
          fromDate.setHours(0, 0, 0, 0);

          // If the "From" date is in the future, hide this route
          if (fromDate > today) {
            return true;
          }
        }
      }

      return false;
    },
    [trips],
  );

  // Guard against undefined viewMapData and use optional chaining for route_id
  // Also filter out routes with future "From <Date>" notes
  const filteredViewMapData = viewMapData
    ? Object.values(viewMapData).filter((el) => {
        const routeId = el?.route_id?.toString();
        return (
          stopRouteIds?.includes(routeId) &&
          !shouldHideRouteDueToFutureDate(routeId)
        );
      })
    : [];

  if (sidebarDisabled) return null;
  // Hide when train detail panel is open
  if (isDetailPanelOpen) return null;
  // Show bar when we have Back-on-Track routes for this station
  const hasBackOnTrackRoutes =
    !!stopRouteIds?.length && filteredViewMapData?.length > 0;
  if (!hasBackOnTrackRoutes) return null;

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
      });
    }
  });

  return (
    <div
      className={`absolute ${isOpen ? "bottom-0" : "-bottom-[100px]"} w-full max-h-7 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.1)] z-[1000] overflow-y-none overflow-x-scroll transition-[right] duration-300 p-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]`}
    >
      <div className="flex p-1">
        {/* Back-on-Track routes */}
        {Array.from(routeMap.values()).map((route, index) => {
          // Get color for this route (same logic as DynamicMap.js)
          const routeColor =
            ROUTE_COLORS[parseInt(route.routeId) % ROUTE_COLORS.length];

          return (
            <div
              className="relative flex items-center pl-2 pr-3 whitespace-nowrap text-sm cursor-pointer hover:bg-gray-100 transition-colors"
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
