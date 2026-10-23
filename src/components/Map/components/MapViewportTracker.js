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
 * Emits the current map viewport.
 * This keeps marker rendering logic independent from Leaflet internals.
 *
 * `onViewportChange` fires on zoom only — station thinning is laid out per
 * zoom and must not reshuffle while the user drags. `onViewportSettle` fires
 * whenever the map comes to rest (pan or zoom), for marker culling.
 */
export default function MapViewportTracker({ onViewportChange, onViewportSettle }) {
  const map = useMapEvents({
    zoomend: () => {
      onViewportChange({
        zoom: map.getZoom(),
        bounds: serializeBounds(map.getBounds()),
      });
    },
    moveend: () => {
      onViewportSettle?.({
        zoom: map.getZoom(),
        bounds: serializeBounds(map.getBounds()),
      });
    },
  });

  useEffect(() => {
    const viewport = {
      zoom: map.getZoom(),
      bounds: serializeBounds(map.getBounds()),
    };
    onViewportChange(viewport);
    onViewportSettle?.(viewport);
  }, [map, onViewportChange, onViewportSettle]);

  return null;
}
