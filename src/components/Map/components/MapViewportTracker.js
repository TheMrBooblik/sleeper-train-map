"use client";

import { useEffect } from "react";
import { useMapEvents } from "react-leaflet";

/**
 * Emits the current map zoom whenever the map zooms.
 * Bounds are not needed — thinning uses a fixed world-coordinate grid
 * that is viewport-position-independent.
 */
export default function MapViewportTracker({ onViewportChange }) {
  const map = useMapEvents({
    zoomend: () => {
      onViewportChange({ zoom: map.getZoom() });
    },
  });

  useEffect(() => {
    onViewportChange({ zoom: map.getZoom() });
  }, [map, onViewportChange]);

  return null;
}
