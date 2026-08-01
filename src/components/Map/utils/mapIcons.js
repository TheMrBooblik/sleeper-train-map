/**
 * Leaflet map marker icons for stations.
 * Used by DynamicMap for default, selected, and via (intermediate) stations.
 *
 * Visual dots stay small so the map stays readable; the DivIcon wrapper is
 * larger (44×44) so touch taps land reliably — same idea as the invisible
 * 24px hit polylines on routes.
 */

const HIT = 44;

function stationDotHtml({ size, gradient, border, shadow, zIndex }) {
  const offset = (HIT - size) / 2;
  return `<div style="width:${HIT}px;height:${HIT}px;display:flex;align-items:center;justify-content:center;cursor:pointer;">
    <div style="width:${size}px;height:${size}px;margin:${offset}px;background:${gradient};border-radius:50%;border:${border};box-shadow:${shadow};transition:all 0.3s ease;z-index:${zIndex};"></div>
  </div>`;
}

/**
 * Create DivIcon instances for station markers.
 * @param {typeof import('leaflet')} Leaflet - Leaflet library
 * @returns {{ defaultIcon: L.DivIcon, selectedIcon: L.DivIcon, viaIcon: L.DivIcon }}
 */
export function createMapIcons(Leaflet) {
  const defaultIcon = new Leaflet.DivIcon({
    className: "station-dot",
    html: stationDotHtml({
      size: 20,
      gradient: "linear-gradient(135deg, #2196F3, #1976D2)",
      border: "3px solid white",
      shadow:
        "0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2)",
      zIndex: 1000,
    }),
    iconSize: [HIT, HIT],
    iconAnchor: [HIT / 2, HIT / 2],
  });

  const selectedIcon = new Leaflet.DivIcon({
    className: "selected-station-dot",
    html: stationDotHtml({
      size: 20,
      gradient: "linear-gradient(135deg, #FF5722, #E64A19)",
      border: "3px solid white",
      shadow:
        "0 3px 8px rgba(255, 87, 34, 0.5), 0 0 0 1px rgba(255, 87, 34, 0.3)",
      zIndex: 2000,
    }),
    iconSize: [HIT, HIT],
    iconAnchor: [HIT / 2, HIT / 2],
  });

  // Via dots: bump visual size slightly (16px) and keep the same 44px hit area.
  const viaIcon = new Leaflet.DivIcon({
    className: "via-dot",
    html: stationDotHtml({
      size: 16,
      gradient: "linear-gradient(135deg, #4CAF50, #388E3C)",
      border: "2px solid white",
      shadow:
        "0 2px 6px rgba(76, 175, 80, 0.35), 0 0 0 1px rgba(76, 175, 80, 0.2)",
      zIndex: 100,
    }),
    iconSize: [HIT, HIT],
    iconAnchor: [HIT / 2, HIT / 2],
  });

  return { defaultIcon, selectedIcon, viaIcon };
}
