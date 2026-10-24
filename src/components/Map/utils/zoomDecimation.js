/**
 * Thin a line's vertices to what a given zoom can show.
 *
 * Leaflet re-projects EVERY vertex of every polyline on every zoom — before it
 * clips to the screen and before its own 1 px simplification — and with "show
 * all routes" on that is ~370 000 vertices a zoom, twice over (each route is a
 * visible line plus an invisible wide hit line). Over Poland, where the PKP
 * GTFS shapes carry 2 500–3 500 points a train, that projection was the whole
 * of the lag: about a second a zoom step on a phone-class CPU.
 *
 * At zoom 6 a pixel is ~1.5 km, and GTFS shapes sample the track every few
 * tens of metres, so almost every vertex lands on a pixel some neighbour
 * already occupies. This drops a vertex closer than `tolerancePx` (in screen
 * pixels at `zoom`) to the last one kept — radial-distance decimation, O(n),
 * with the error bounded by the tolerance: every dropped vertex lies within
 * it of a kept one, which the drawn segment passes through. Half a pixel,
 * under Leaflet's own 1 px smoothing, so nothing visible moves; zoomed in far
 * enough that vertices are a pixel apart, every one is kept.
 *
 * Distances are local Web Mercator: a degree of latitude spans 1/cos(lat)
 * times the pixels a degree of longitude does.
 */

/** Pixels per degree of longitude at `zoom` (256 px tiles). */
function pxPerDegree(zoom) {
  return (256 * 2 ** zoom) / 360;
}

const latOf = (p) => (Array.isArray(p) ? p[0] : p.lat);
const lngOf = (p) => (Array.isArray(p) ? p[1] : p.lng);

/**
 * @template P  [lat, lng] arrays or Leaflet LatLng objects (returned as-is)
 * @param {P[]} points
 * @param {number} zoom
 * @param {number} [tolerancePx]
 * @returns {P[]} `points` itself when nothing could be dropped
 */
export function decimateForZoom(points, zoom, tolerancePx = 0.5) {
  if (!Array.isArray(points) || points.length <= 2 || !Number.isFinite(zoom)) {
    return points;
  }
  const tolDeg = tolerancePx / pxPerDegree(zoom);
  const tol2 = tolDeg * tolDeg;
  const out = [points[0]];
  let lastLat = latOf(points[0]);
  let lastLng = lngOf(points[0]);
  let latScale = 1 / Math.max(Math.cos((lastLat * Math.PI) / 180), 1e-6);
  const last = points.length - 1;
  for (let i = 1; i < last; i++) {
    const p = points[i];
    const lat = latOf(p);
    const lng = lngOf(p);
    const dx = lng - lastLng;
    const dy = (lat - lastLat) * latScale;
    if (dx * dx + dy * dy < tol2) continue;
    out.push(p);
    lastLat = lat;
    lastLng = lng;
    latScale = 1 / Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  }
  out.push(points[last]);
  return out.length === points.length ? points : out;
}

/**
 * The stretches of a line that come anywhere near a window: runs of
 * consecutive points whose segments' bounding boxes touch it. A segment is
 * tested, not its end points, so a long straight hop crossing the window with
 * both ends outside it (station-chain lines have vertices 100+ km apart) is
 * still kept.
 *
 * @template P
 * @param {P[]} points
 * @param {{south:number, west:number, north:number, east:number}} w
 * @returns {P[][]} `[points]` itself when the whole line is inside
 */
export function runsNearWindow(points, w) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const runs = [];
  let run = null;
  let all = true;
  let aLat = latOf(points[0]);
  let aLng = lngOf(points[0]);
  for (let i = 1; i < points.length; i++) {
    const bLat = latOf(points[i]);
    const bLng = lngOf(points[i]);
    const near = !(
      (aLat < bLat ? bLat : aLat) < w.south ||
      (aLat < bLat ? aLat : bLat) > w.north ||
      (aLng < bLng ? bLng : aLng) < w.west ||
      (aLng < bLng ? aLng : bLng) > w.east
    );
    if (near) {
      if (!run) {
        run = [points[i - 1]];
        runs.push(run);
      }
      run.push(points[i]);
    } else {
      all = false;
      run = null;
    }
    aLat = bLat;
    aLng = bLng;
  }
  return all ? [points] : runs;
}

/** Screens of padding around the view that a line is projected for. */
export const PROJECTION_PADDING_SCREENS = 1;

/**
 * A Leaflet Polyline that projects only what the view can show.
 *
 * Two cuts, both invisible. Per zoom, vertices closer than half a pixel are
 * dropped (decimateForZoom, cached per zoom level). And only the stretches
 * within a screen of the view are projected at all: zoomed in over Poland, a
 * Nightjet line that runs on to Amsterdam and Rome was projected end to end on
 * every zoom although the canvas only ever draws what is on screen. When a pan
 * carries the view out of the projected window, the line re-projects on the
 * next `moveend` — the only moment the canvas renderer redraws anyway.
 *
 * Everything else — `getLatLngs()`, bounds, styling, events, tooltips — still
 * sees the full line. Leaflet is passed in rather than imported so this module
 * stays loadable in raw node for the tests.
 *
 * @param {typeof import("leaflet")} L
 */
export function createDecimatedPolylineClass(L) {
  return L.Polyline.extend({
    _setLatLngs(latlngs) {
      L.Polyline.prototype._setLatLngs.call(this, latlngs);
      this._decimatedByZoom = null;
    },

    _project() {
      const latlngs = this._latlngs;
      // Multi-part lines keep Leaflet's own path; every route line here is flat.
      if (!this._map || !(latlngs?.[0] instanceof L.LatLng)) {
        this._projectedWindow = null;
        L.Polyline.prototype._project.call(this);
        return;
      }
      // Rounded up, so a fractional zoom is thinned for the finer level.
      const zoom = Math.ceil(this._map.getZoom());
      if (!this._decimatedByZoom) this._decimatedByZoom = new Map();
      let thinned = this._decimatedByZoom.get(zoom);
      if (!thinned) {
        thinned = decimateForZoom(latlngs, zoom);
        this._decimatedByZoom.set(zoom, thinned);
      }
      const window = this._map.getBounds().pad(PROJECTION_PADDING_SCREENS);
      this._projectedWindow = window;
      const runs = runsNearWindow(thinned, {
        south: window.getSouth(),
        west: window.getWest(),
        north: window.getNorth(),
        east: window.getEast(),
      });
      const pxBounds = new L.Bounds();
      this._rings = [];
      for (const run of runs) this._projectLatlngs(run, this._rings, pxBounds);
      if (this._bounds.isValid() && pxBounds.isValid()) {
        this._rawPxBounds = pxBounds;
        this._updateBounds();
      } else {
        // Nothing near the view: nothing to draw or hit-test until it is.
        this._rawPxBounds = null;
        this._pxBounds = null;
      }
    },

    _update() {
      if (
        this._map &&
        this._projectedWindow &&
        // The canvas draws a margin beyond the view (its `padding`), and a
        // drag shows that margin before the next redraw.
        !this._projectedWindow.contains(
          this._map.getBounds().pad(this._renderer?.options?.padding ?? 0.1),
        )
      ) {
        this._project();
      }
      L.Polyline.prototype._update.call(this);
    },
  });
}
