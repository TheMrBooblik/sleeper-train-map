"use client";

import React from "react";

/**
 * Shared tooltip content for a station: name always, Dep/Arr only when showTimes is true.
 * Use showTimes=true when a specific train route is selected; otherwise station name only.
 * Used by NightTrainLayer and Back-on-Track station markers (e.g. useMapMarkers).
 */
export function StationTooltipContent({ name, departure, arrival, showTimes, note }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{name}</div>
      {/* Why this dot is faded — without it the difference is visible but
          unexplained until the user opens the legend. */}
      {note && (
        <div style={{ opacity: 0.75, fontSize: "0.9em" }}>{note}</div>
      )}
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
