"use client";

import { useEffect } from "react";
import { useMapEvents } from "react-leaflet";

function serializeBounds(bounds) {
  if (!bounds) return null;
  const northEast = bounds.getNorthEast();
  const southWest = bounds.getSouthWest();

  return {
    north: northEast.lat,
    east: northEast.lng,
    south: southWest.lat,
    west: southWest.lng,
  };
}

/**
 * Emits current map viewport whenever map moves/zooms.
 * This keeps marker rendering logic independent from Leaflet internals.
 */
export default function MapViewportTracker({ onViewportChange }) {
  const map = useMapEvents({
    zoomend: () => {
      onViewportChange({
        zoom: map.getZoom(),
        bounds: serializeBounds(map.getBounds()),
      });
    },
  });

  useEffect(() => {
    onViewportChange({
      zoom: map.getZoom(),
      bounds: serializeBounds(map.getBounds()),
    });
  }, [map, onViewportChange]);

  return null;
}
