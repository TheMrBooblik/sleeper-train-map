/**
 * Leaflet map marker icons for stations.
 * Used by DynamicMap for default, selected, and via (intermediate) stations.
 */

/**
 * Create DivIcon instances for station markers.
 * @param {typeof import('leaflet')} Leaflet - Leaflet library
 * @returns {{ defaultIcon: L.DivIcon, selectedIcon: L.DivIcon, viaIcon: L.DivIcon }}
 */
export function createMapIcons(Leaflet) {
  const defaultIcon = new Leaflet.DivIcon({
    className: "station-dot",
    html: '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  const selectedIcon = new Leaflet.DivIcon({
    className: "selected-station-dot",
    html: '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #FF5722, #E64A19); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(255, 87, 34, 0.5), 0 0 0 1px rgba(255, 87, 34, 0.3); transition: all 0.3s ease; cursor: pointer; z-index: 2000;"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  const viaIcon = new Leaflet.DivIcon({
    className: "via-dot",
    html: '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  return { defaultIcon, selectedIcon, viaIcon };
}
