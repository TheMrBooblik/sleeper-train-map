"use client";

import React from "react";
import styles from "./TrainSidebar.module.scss";
import { useViewMap } from "../../hooks/requests/useViewMap";

// Route colors matching DynamicMap.js
const ROUTE_COLORS = [
  "#FF6B35", // Orange-red
  "#4A90E2", // Blue
  "#50C878", // Green
  "#9B59B6", // Purple
  "#F39C12", // Orange
  "#E74C3C", // Red
  "#3498DB", // Light blue
  "#2ECC71", // Light green
];

const TrainSidebar = ({
  isOpen,
  sidebarDisabled,
  stopId,
  stopRouteIds,
  selectedNormalizedName,
}) => {
  const { viewMapData } = useViewMap();
  // Guard against undefined viewMapData and use optional chaining for route_id
  const filteredViewMapData = viewMapData
    ? Object.values(viewMapData).filter((el) =>
        stopRouteIds?.includes(el?.route_id?.toString()),
      )
    : [];

  if (!stopRouteIds?.length || sidebarDisabled) return null;

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
    <div className={`${styles.trainSidebar} ${isOpen ? styles.open : ""}`}>
      <div className="flex p-1">
        {Array.from(routeMap.values()).map((route, index) => {
          // Get color for this route (same logic as DynamicMap.js)
          const routeColor =
            ROUTE_COLORS[parseInt(route.routeId) % ROUTE_COLORS.length];

          return (
            <div
              className={`${styles.routeItem} whitespace-nowrap text-sm`}
              key={`route-info-${index}`}
            >
              {/* Color indicator line */}
              <div
                className={styles.routeColorLine}
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

export default TrainSidebar;
