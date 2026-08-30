/**
 * Geometry reduction for the mobile payload.
 *
 * The web map decodes ~334k coordinate points across 329 strokes, most of them
 * invisible: a sleeper map is read at country scale, where a 55 m deviation is a
 * fraction of the line's own stroke width. Shipping that resolution to a phone
 * costs payload, parse time and per-frame work for nothing, so the build
 * simplifies before re-encoding.
 *
 * Why simplify here rather than on the device: it is deterministic, it happens
 * once for every user instead of once per install, and flutter_map's own
 * `simplificationTolerance` still has to walk the full point list every frame.
 *
 * Raw node, no dependencies beyond @mapbox/polyline. Covered by
 * tests/verify-mobile-payload.mjs.
 */
import polyline from "@mapbox/polyline";

/**
 * ~55 m at European latitudes. Chosen against the zoom range this map actually
 * uses (continent to city), where it is not visible; raise it and station-chain
 * corners start to cut, lower it and the payload grows for detail nobody sees.
 */
export const DEFAULT_TOLERANCE_DEG = 5e-4;

/** Square of the perpendicular distance from p to the segment a→b, in degrees². */
function perpendicularDistanceSq(p, a, b) {
  const dx = b[1] - a[1];
  const dy = b[0] - a[0];
  if (dx === 0 && dy === 0) {
    return (p[1] - a[1]) ** 2 + (p[0] - a[0]) ** 2;
  }
  const t = ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / (dx * dx + dy * dy);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const projX = a[1] + clamped * dx;
  const projY = a[0] + clamped * dy;
  return (p[1] - projX) ** 2 + (p[0] - projY) ** 2;
}

/**
 * Douglas–Peucker, iterative so a 20k-point relation cannot blow the stack.
 *
 * @param {Array<[number, number]>} points [lat, lng] pairs
 * @param {number} toleranceDeg
 * @returns {Array<[number, number]>} a subset of `points`, endpoints always kept
 */
export function simplifyPath(points, toleranceDeg = DEFAULT_TOLERANCE_DEG) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];

  const tolSq = toleranceDeg * toleranceDeg;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    let maxDistSq = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distSq = perpendicularDistanceSq(
        points[i],
        points[first],
        points[last],
      );
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        index = i;
      }
    }

    if (maxDistSq > tolSq && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Drop consecutive duplicates left behind by station chains that call at the
 * same coordinate twice (a reversal, or two stops sharing one custom coord).
 * @param {Array<[number, number]>} points
 */
export function dedupeConsecutive(points) {
  if (!Array.isArray(points) || points.length < 2) return points || [];
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[out.length - 1];
    if (points[i][0] !== prev[0] || points[i][1] !== prev[1])
      out.push(points[i]);
  }
  return out;
}

/**
 * Simplify and encode one stroke to a precision-5 polyline string — the same
 * encoding the payload already uses for `nj_polyline_*`, so the app needs one
 * decoder for everything.
 *
 * @param {Array<[number, number]>} points
 * @param {number} toleranceDeg
 * @returns {{encoded: string, pointsIn: number, pointsOut: number}|null} null when
 *   fewer than two distinct points survive — a one-point stroke draws nothing.
 */
export function encodeStroke(points, toleranceDeg = DEFAULT_TOLERANCE_DEG) {
  const cleaned = dedupeConsecutive(
    (points || []).filter(
      (p) =>
        Array.isArray(p) &&
        p.length >= 2 &&
        Number.isFinite(+p[0]) &&
        Number.isFinite(+p[1]),
    ),
  );
  if (cleaned.length < 2) return null;

  const simplified = simplifyPath(cleaned, toleranceDeg);
  if (simplified.length < 2) return null;

  return {
    encoded: polyline.encode(simplified),
    pointsIn: cleaned.length,
    pointsOut: simplified.length,
  };
}

/**
 * Leaflet accepts a dash pattern as "10,5" or "8 6"; Flutter's StrokePattern
 * wants numbers. Normalising here means the app never parses a style string.
 *
 * The even length is not cosmetic: `StrokePattern.dashed` asserts on it, so an
 * odd pattern reaching the app is a crash rather than an ugly line. Segments are
 * dash/gap pairs, so a trailing lone value has no gap to go with it and is
 * dropped.
 *
 * @param {string|undefined} dashArray
 * @returns {number[]|null}
 */
export function parseDashArray(dashArray) {
  if (!dashArray) return null;
  const parts = String(dashArray)
    .split(/[\s,]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  const paired = parts.length % 2 === 0 ? parts : parts.slice(0, -1);
  return paired.length >= 2 ? paired : null;
}
