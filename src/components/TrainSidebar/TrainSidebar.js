"use client";

import React from "react";
import styles from "./TrainSidebar.module.scss";
import { useViewMap } from "../../hooks/requests/useViewMap";

const TrainSidebar = ({
  isOpen,
  sidebarDisabled,
  stopId,
  stopRouteIds,
  selectedNormalizedName,
}) => {
  const { viewMapData } = useViewMap();
  const filteredViewMapData = Object.values(viewMapData).filter((el) =>
    stopRouteIds?.includes(el?.route_id.toString()),
  );

  if (!stopRouteIds?.length || sidebarDisabled) return null;

  // Group routes by origin-destination to avoid duplicates
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
      });
    }
  });

  return (
    <div className={`${styles.trainSidebar} ${isOpen ? styles.open : ""}`}>
      <div className="flex p-1">
        {Array.from(routeMap.values()).map((route, index) => (
          <div
            className="whitespace-nowrap text-sm [&:not(:last-child)]:border-r px-2"
            key={`route-info-${index}`}
          >
            <strong>{route.origin}</strong>
            &nbsp;-&nbsp;
            {route.viaText ? <span>({route.viaText})</span> : null}
            {route.viaText && <>&nbsp;-&nbsp;</>}
            <strong>{route.destination}</strong>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TrainSidebar;
