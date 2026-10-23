/**
 * Which part of the world the station markers are rendered for.
 *
 * Every station marker is a DOM element, and Leaflet moves every one of them on
 * every zoom whether it is on screen or not — and forces a style and layout
 * pass over all of them when it swaps tile levels. Thinning keeps every
 * route endpoint in the world (they must not vanish when zoomed out), and from
 * zoom 8 it keeps every station, so over Poland at zoom 8 the map carried
 * ~2 100 markers to show ~80: each zoom step blocked the main thread for the
 * better part of a second on a phone.
 *
 * So markers are rendered only inside the viewport padded by one screen on
 * every side. A pan shorter than a screen therefore never reveals an
 * unrendered area, and the region is only recomputed once the view leaves it
 * (or the zoom changes), so an ordinary pan re-renders nothing at all.
 */

/** Screens of padding on each side of the viewport. */
export const CULL_PADDING_SCREENS = 1;

function isFiniteBounds(b) {
  return (
    !!b &&
    [b.north, b.south, b.east, b.west].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) &&
    b.north >= b.south &&
    b.east >= b.west
  );
}

/**
 * The viewport grown by `screens` of its own size on each side.
 * @param {{north:number,south:number,east:number,west:number}} viewport
 * @param {number} [screens]
 */
export function padBounds(viewport, screens = CULL_PADDING_SCREENS) {
  const latPad = (viewport.north - viewport.south) * screens;
  const lonPad = (viewport.east - viewport.west) * screens;
  return {
    north: viewport.north + latPad,
    south: viewport.south - latPad,
    east: viewport.east + lonPad,
    west: viewport.west - lonPad,
  };
}

function contains(outer, inner) {
  return (
    inner.north <= outer.north &&
    inner.south >= outer.south &&
    inner.east <= outer.east &&
    inner.west >= outer.west
  );
}

/**
 * The cull region to use after the map settles at `viewport`/`zoom`. Returns
 * `current` itself (same identity, so nothing re-renders) while the viewport
 * is still inside it at the same zoom; a fresh padded region otherwise.
 *
 * @param {{bounds:object, zoom:number}|null} current
 * @param {{north:number,south:number,east:number,west:number}|null} viewport
 * @param {number|null} zoom
 * @returns {{bounds:object, zoom:number}|null}
 */
export function nextCullRegion(current, viewport, zoom) {
  if (!isFiniteBounds(viewport)) return null;
  if (
    current &&
    current.zoom === zoom &&
    isFiniteBounds(current.bounds) &&
    contains(current.bounds, viewport)
  ) {
    return current;
  }
  return { bounds: padBounds(viewport), zoom };
}

/**
 * Whether a marker at lat/lon is rendered. No region (bounds not known yet)
 * keeps everything, as before culling existed; so does a marker without a
 * usable position — that decision belongs to the caller.
 */
export function isInsideCullRegion(region, lat, lon) {
  if (!region || !isFiniteBounds(region.bounds)) return true;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return true;
  const b = region.bounds;
  return la <= b.north && la >= b.south && lo <= b.east && lo >= b.west;
}
