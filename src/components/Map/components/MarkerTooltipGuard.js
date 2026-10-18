"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";

/**
 * Whether a station marker's tooltip has a reason to be open: the cursor is
 * on the marker, or the keyboard focused it. A marker focused by a mouse click
 * does not count — `:focus-visible` is false for that — because the browser
 * re-fires `focus` on it when the window regains focus, and Leaflet opens the
 * tooltip on focus with nothing left to close it.
 */
function markerWantsTooltip(el) {
  try {
    return el.matches(":hover") || el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Closes station tooltips whose cursor has gone.
 *
 * Leaflet opens a marker's tooltip on `mouseover` and closes it on `mouseout`,
 * and a drag loses that `mouseout` two ways. While the map is dragged a hover
 * is not shown but queued and replayed on `moveend` (`Layer._openTooltip`);
 * the pane trails the cursor by a frame, so a quick drag starting on a station
 * runs the cursor across its neighbours, each one queues an open, and their
 * `mouseout` fires before the tooltip exists. And after the drag the map keeps
 * gliding under a still cursor: a dot sliding under it opens its tooltip, and
 * sliding away again sends no `mouseout`. Either way the name hangs on the map
 * until that station is hovered again — several at once after a few drags.
 *
 * So every open station tooltip is re-checked against the marker's `:hover`
 * just after it opens, when the map stops moving, and on the next mouse move
 * over the map. Markers only: they are DOM elements, so `:hover` answers
 * exactly, while the route lines are drawn on canvas, whose renderer ignores
 * the cursor during a drag. Desktop only — on touch the tooltip opens from the
 * tap itself and a finger has no hover.
 */
export default function MarkerTooltipGuard() {
  const map = useMap();

  useEffect(() => {
    // Same media query as the route hover in DynamicMap.
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      return undefined;
    }
    const open = new Set();
    let frame = null;

    const sweep = () => {
      frame = null;
      open.forEach((layer) => {
        const el = layer.getElement?.();
        if (!el || !layer.isTooltipOpen?.()) {
          open.delete(layer);
        } else if (!markerWantsTooltip(el)) {
          layer.closeTooltip();
        }
      });
    };
    // Once a frame at most. Not synchronously either: `tooltipopen` fires
    // from inside the tooltip's own `onAdd`, and removing a layer mid-add
    // leaves Leaflet half-updated.
    const scheduleSweep = () => {
      if (frame == null && open.size > 0) {
        frame = requestAnimationFrame(sweep);
      }
    };

    const onTooltipOpen = (event) => {
      const layer = event.tooltip?._source;
      // Markers have a position and an element; lines and permanent labels
      // are left alone.
      if (!layer?.getLatLng || !layer.getElement) return;
      if (event.tooltip.options?.permanent) return;
      open.add(layer);
      scheduleSweep();
    };
    const onTooltipClose = (event) => {
      const layer = event.tooltip?._source;
      if (layer) open.delete(layer);
    };

    const container = map.getContainer();
    map.on("tooltipopen", onTooltipOpen);
    map.on("tooltipclose", onTooltipClose);
    map.on("moveend", scheduleSweep);
    container.addEventListener("mousemove", scheduleSweep, { passive: true });
    return () => {
      map.off("tooltipopen", onTooltipOpen);
      map.off("tooltipclose", onTooltipClose);
      map.off("moveend", scheduleSweep);
      container.removeEventListener("mousemove", scheduleSweep);
      if (frame != null) cancelAnimationFrame(frame);
      open.clear();
    };
  }, [map]);

  return null;
}
