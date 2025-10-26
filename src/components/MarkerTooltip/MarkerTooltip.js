import React, { memo, useEffect } from "react";
import { Tooltip } from "react-leaflet";
import styles from "./MarkerTooltip.module.scss";

// Memoize the tooltip to prevent unnecessary re-renders
const MarkerTooltip = memo(({ stationName, stationId, groupedStations }) => {
  // Skip rendering if essential props are missing
  if (!stationName || !stationId) return null;

  return (
    <div className={styles.tooltipContent}>
      <abbr title={`Station ID: ${stationId}`}>
        <span className={styles.stationName}>{stationName}</span>
      </abbr>

      {/* Show grouped stations if this is a grouped marker */}
      {groupedStations && groupedStations.length > 1 && (
        <div className={styles.groupedStations}>
          <div className={styles.groupHeader}>
            {groupedStations.length} stations in {stationName}:
          </div>
          <div className={styles.stationList}>
            {groupedStations.map((station, index) => (
              <div key={index} className={styles.stationItem}>
                • {station.originalName}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default MarkerTooltip;
