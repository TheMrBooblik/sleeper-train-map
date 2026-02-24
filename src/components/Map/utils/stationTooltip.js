"use client";

import React from "react";

/**
 * Shared tooltip content for a station: name always, Dep/Arr only when showTimes is true.
 * Use showTimes=true when a specific train route is selected; otherwise station name only.
 * Used by NightTrainLayer and Back-on-Track station markers (e.g. useMapMarkers).
 */
export function StationTooltipContent({ name, departure, arrival, showTimes }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{name}</div>
      {showTimes && (
        <>
          {departure && (
            <div>
              Dep:{" "}
              {new Date(departure).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
          {arrival && (
            <div>
              Arr:{" "}
              {new Date(arrival).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
