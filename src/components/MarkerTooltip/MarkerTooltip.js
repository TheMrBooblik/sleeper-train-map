import React, { memo, useEffect } from 'react';
import { Tooltip } from 'react-leaflet';
import styles from './MarkerTooltip.module.scss';

// Memoize the tooltip to prevent unnecessary re-renders
const MarkerTooltip = memo(({ stationName, stationId }) => {
  // Skip rendering if essential props are missing
  if (!stationName || !stationId) return null;

  return (
    <div className={styles.tooltipContent}>
      <abbr title={`Station ID: ${stationId}`}>
        <span className={styles.stationName}>{stationName}</span>
      </abbr>
    </div>
  );
});

export default MarkerTooltip;
