/**
 * Leaflet TileLayer options tuned for what the connection can actually carry.
 *
 * Tiles are the one cost that scales with how much the user moves the map
 * rather than with the dataset, and they compete for bandwidth with the data
 * payloads. Two of these apply always because they only ever remove requests
 * for tiles nobody sees; the third is held back for connections that ask for
 * it, because it makes a fast desktop map feel worse.
 */

/**
 * Whether the browser is telling us to be frugal. The Network Information API
 * is Chromium-only, so this is a progressive enhancement: elsewhere it returns
 * false and Leaflet's own defaults stand.
 *
 * @returns {boolean}
 */
export function prefersFewerRequests() {
  if (typeof navigator === "undefined") return false;
  const connection =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return false;
  // saveData is the user's explicit "I am paying for this" signal.
  if (connection.saveData) return true;
  return /(^|-)2g$/.test(connection.effectiveType || "");
}

/**
 * @param {{ isMobile?: boolean }} [context]
 * @returns {object} options to spread onto <TileLayer>
 */
export function tileLoadingOptions({ isMobile = false } = {}) {
  const options = {
    // Don't fetch the zoom levels a zoom animation passes through — only the
    // one it lands on. Leaflet defaults this to true.
    updateWhenZooming: false,
    // One screen of off-viewport tiles instead of two. Halves the tiles a pan
    // pulls in ahead of itself.
    keepBuffer: 1,
  };

  // Load tiles when a gesture settles rather than during it. Leaflet already
  // does this on mobile, so only ever turn it ON — passing it unconditionally
  // would switch it off for mobile users on a good connection.
  if (isMobile || prefersFewerRequests()) options.updateWhenIdle = true;

  return options;
}
