"use client";

import Leaflet from "leaflet";
import {
  createElementObject,
  createPathComponent,
  extendContext,
} from "@react-leaflet/core";
import { createDecimatedPolylineClass } from "../utils/zoomDecimation";

const LeafletDecimatedPolyline = createDecimatedPolylineClass(Leaflet);

/**
 * react-leaflet's <Polyline>, drawn from a per-zoom thinned copy of its
 * vertices (utils/zoomDecimation.js). Same props, same behaviour — this is the
 * component react-leaflet ships, with a different Leaflet class inside.
 */
export const DecimatedPolyline = createPathComponent(
  function createPolyline({ positions, ...options }, ctx) {
    const polyline = new LeafletDecimatedPolyline(positions, options);
    return createElementObject(
      polyline,
      extendContext(ctx, { overlayContainer: polyline }),
    );
  },
  function updatePolyline(layer, props, prevProps) {
    if (props.positions !== prevProps.positions) {
      layer.setLatLngs(props.positions);
    }
  },
);
