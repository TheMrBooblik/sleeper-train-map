/**
 * Corridor de-duplication for routes that carry per-direction geometry.
 *
 * A route with both `nj_polyline_0` and `nj_polyline_1` used to be drawn as two
 * Leaflet polylines. The two directions trace the same corridor, so the second
 * line's dashes landed in the first line's gaps and the route rendered as a
 * solid, heavier line — the dash stopped conveying frequency at all.
 *
 * Most return legs are the outbound leg reversed, but a real minority genuinely
 * differ (a train that returns via another valley). So instead of dropping the
 * return geometry wholesale, this finds the stretches where it actually leaves
 * the outbound path. Callers draw direction 0 plus those branches: nothing is
 * ever drawn twice, and a genuinely different return route still appears.
 */

const EARTH_KM_PER_DEG = 111.32;

/** Grid cell key for a lat/lng at the given cell size in degrees. */
function cellKey(lat, lng, cell) {
  return `${Math.round(lat / cell)}:${Math.round(lng / cell)}`;
}

/**
 * Great-circle-ish distance in km. Equirectangular is plenty here: we only ever
 * compare against a small tolerance, and the cos(lat) term keeps longitude
 * honest at European and Chinese latitudes alike.
 */
function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = (aLat - bLat) * EARTH_KM_PER_DEG;
  const dLng =
    (aLng - bLng) * EARTH_KM_PER_DEG * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/**
 * Copy of `positions` with interpolated points inserted so no two consecutive
 * points sit more than `stepKm` apart.
 *
 * The corridor test asks "is this point near the outbound *line*", but a grid of
 * the outbound *vertices* can only answer "near an outbound point". That is the
 * same question for an encoded polyline sampled every few hundred metres, and a
 * very different one for a station chain whose vertices are 100 km apart — there
 * a return leg stopping at extra intermediate stations sits far from every
 * outbound vertex while riding the identical track. Filling the long segments in
 * first makes both cases behave alike.
 */
function densify(positions, stepKm) {
  const MAX_INSERTED_PER_SEGMENT = 400;
  const out = [];
  for (let i = 0; i < positions.length; i += 1) {
    const point = positions[i];
    const [lat, lng] = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push(point);

    const next = positions[i + 1];
    if (!next) continue;
    const [nextLat, nextLng] = next;
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) continue;

    const gap = distanceKm(lat, lng, nextLat, nextLng);
    if (gap <= stepKm) continue;
    const steps = Math.min(Math.ceil(gap / stepKm), MAX_INSERTED_PER_SEGMENT);
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      out.push([lat + (nextLat - lat) * t, lng + (nextLng - lng) * t]);
    }
  }
  return out;
}

/**
 * Stretches of `positions1` that leave `positions0`.
 *
 * @param {[number, number][]} positions0 Outbound geometry (the corridor).
 * @param {[number, number][]} positions1 Return geometry.
 * @param {object} [options]
 * @param {number} [options.toleranceKm=2] How far the return may sit from the
 *   outbound path and still count as the same corridor. Generous on purpose:
 *   the two directions often use parallel tracks, different platforms, or
 *   slightly different shape sampling, none of which is a different route.
 * @param {number} [options.minBranchPoints=4] Shortest run worth drawing, so
 *   shape noise and station approaches don't spawn slivers.
 * @returns {[number, number][][]} Empty when the return is the same corridor.
 */
export function returnGeometryBranches(
  positions0,
  positions1,
  { toleranceKm = 2, minBranchPoints = 4 } = {},
) {
  if (!Array.isArray(positions0) || !Array.isArray(positions1)) return [];
  if (positions0.length < 2 || positions1.length < 2) return [];

  // Cell size ≈ the tolerance, so a point's nearest neighbour is always in one
  // of the nine cells around it and each lookup stays O(1).
  const cell = toleranceKm / EARTH_KM_PER_DEG;
  const grid = new Map();
  for (const point of densify(positions0, toleranceKm)) {
    const [lat, lng] = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = cellKey(lat, lng, cell);
    const bucket = grid.get(key);
    if (bucket) bucket.push(point);
    else grid.set(key, [point]);
  }
  if (grid.size === 0) return [];

  const isOnCorridor = (lat, lng) => {
    const gi = Math.round(lat / cell);
    const gj = Math.round(lng / cell);
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        const bucket = grid.get(`${gi + di}:${gj + dj}`);
        if (!bucket) continue;
        for (const [pLat, pLng] of bucket) {
          if (distanceKm(lat, lng, pLat, pLng) <= toleranceKm) return true;
        }
      }
    }
    return false;
  };

  const branches = [];
  let run = [];
  const flush = () => {
    if (run.length >= minBranchPoints) branches.push(run);
    run = [];
  };

  for (const point of positions1) {
    const [lat, lng] = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (isOnCorridor(lat, lng)) flush();
    else run.push(point);
  }
  flush();

  return branches;
}

// Computing branches walks both polylines, which can be thousands of points, so
// the result is cached per route. The key includes both lengths: a nightly
// scrape that changes the geometry changes the point counts, and anything
// subtler is one render stale at worst.
const cache = new Map();
const CACHE_LIMIT = 500;

/**
 * Memoised {@link returnGeometryBranches}, keyed by route.
 * @param {string|number} routeId
 */
export function cachedReturnGeometryBranches(routeId, positions0, positions1, options) {
  const key = `${routeId}:${positions0?.length ?? 0}:${positions1?.length ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const branches = returnGeometryBranches(positions0, positions1, options);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, branches);
  return branches;
}
