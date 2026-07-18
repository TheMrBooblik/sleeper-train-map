// scripts/lib/sibling-path.mjs
// When an official stop list is sparse, a stops-chain polyline jumps across
// the country in long chords. This module borrows intermediate coordinates
// from denser sibling routes that pass near both ends of a long gap — path
// only, never as visible stations (detail panel / map markers stay clean).

/** Great-circle distance in km between [lat, lon] points. */
export function haversineKm([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function nearestIdx(path, point) {
  let best = 0;
  let bestKm = Infinity;
  for (let i = 0; i < path.length; i++) {
    const km = haversineKm(path[i], point);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  return { idx: best, km: bestKm };
}

/**
 * Best intermediate slice from a sibling path that bridges A→B.
 * Returns exclusive intermediates (A/B themselves omitted), or null.
 */
export function siblingSliceBetween(a, b, siblingPath, matchKm) {
  if (!Array.isArray(siblingPath) || siblingPath.length < 3) return null;
  const nearA = nearestIdx(siblingPath, a);
  const nearB = nearestIdx(siblingPath, b);
  if (nearA.km > matchKm || nearB.km > matchKm) return null;
  if (nearA.idx === nearB.idx) return null;

  const lo = Math.min(nearA.idx, nearB.idx);
  const hi = Math.max(nearA.idx, nearB.idx);
  // Need at least one real intermediate between the matched indices.
  if (hi - lo < 2) return null;

  let mid = siblingPath.slice(lo + 1, hi);
  // Orient mid so it runs A → B (sibling may run the opposite way).
  if (nearA.idx > nearB.idx) mid = [...mid].reverse();
  return mid.length ? mid : null;
}

/**
 * Fill long consecutive jumps in `path` using points from `siblingPaths`.
 * Does not mutate inputs. gapKm = minimum jump to try filling.
 */
export function densifyPathWithSiblings(
  path,
  siblingPaths,
  { gapKm = 400, matchKm = 50 } = {},
) {
  if (!Array.isArray(path) || path.length < 2) return path ?? [];
  const donors = (siblingPaths ?? []).filter(
    (p) => Array.isArray(p) && p.length >= 3,
  );
  if (!donors.length) return path;

  const out = [path[0]];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const gap = haversineKm(a, b);
    let mid = [];
    if (gap > gapKm) {
      // Prefer the densest bridging sibling (most intermediates).
      let best = null;
      for (const donor of donors) {
        const slice = siblingSliceBetween(a, b, donor, matchKm);
        if (!slice?.length) continue;
        if (!best || slice.length > best.length) best = slice;
      }
      if (best) mid = best;
    }
    out.push(...mid, b);
  }
  return out;
}

/**
 * Coord chain from a chinese-trains station list (skips coordless stops).
 */
export function coordPathFromStations(stations) {
  const path = [];
  for (const s of stations ?? []) {
    const lat = s?.location?.latitude;
    const lon = s?.location?.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lon)) path.push([lat, lon]);
  }
  return path;
}
