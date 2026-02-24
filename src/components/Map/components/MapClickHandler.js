"use client";

import React from "react";
import { useMapEvents } from "react-leaflet";

/**
 * Handles map click: clears filter when user clicks on empty map (not on markers/polylines).
 * Must be rendered inside MapContainer.
 */
export default function MapClickHandler({
  hasSelection,
  onClearFilter,
}) {
  useMapEvents({
    click: (e) => {
      const isClickOnFeature = e.originalEvent.target.classList.contains(
        "leaflet-interactive",
      );
      if (!isClickOnFeature && hasSelection) {
        onClearFilter();
      }
    },
  });
  return null;
}
