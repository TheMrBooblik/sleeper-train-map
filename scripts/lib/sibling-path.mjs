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

/** Stable string for tie-breaking donor choice (same gap → same donor). */
function pathFingerprint(path) {
  return (path ?? [])
    .map(([lat, lon]) => `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`)
    .join(";");
}

export function maxSegmentKm(path) {
  let max = 0;
  for (let i = 0; i < (path?.length ?? 0) - 1; i++) {
    max = Math.max(max, haversineKm(path[i], path[i + 1]));
  }
  return max;
}

/**
 * Fill long consecutive jumps in `path` using points from `siblingPaths`.
 * Does not mutate inputs. gapKm = minimum jump to try filling.
 * Donor ties break on fingerprint so outbound/return gaps prefer the same fill.
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
      // Densest bridge wins; equal density → stable fingerprint (deterministic).
      let best = null;
      let bestFp = null;
      for (const donor of donors) {
        const slice = siblingSliceBetween(a, b, donor, matchKm);
        if (!slice?.length) continue;
        const fp = pathFingerprint(slice);
        if (
          !best ||
          slice.length > best.length ||
          (slice.length === best.length && fp < bestFp)
        ) {
          best = slice;
          bestFp = fp;
        }
      }
      if (best) mid = best;
    }
    out.push(...mid, b);
  }
  return out;
}

/**
 * Midpoint distance between path and reversed other — used to detect
 * there-and-back corridor drift after independent densify.
 */
export function reverseMidpointKm(pathA, pathB) {
  if (!pathA?.length || !pathB?.length) return Infinity;
  const rev = [...pathB].reverse();
  const midA = pathA[Math.floor(pathA.length / 2)];
  const midB = rev[Math.floor(rev.length / 2)];
  return haversineKm(midA, midB);
}

/**
 * Mirror `winner` onto the return direction: reverse the shared corridor and
 * snap endpoints to the return train's official first/last coords.
 */
export function mirrorPathForReturn(winnerPath, returnEndPoints) {
  if (!winnerPath?.length || returnEndPoints?.length < 2) return null;
  const mirrored = winnerPath.map((p) => [p[0], p[1]]);
  mirrored.reverse();
  mirrored[0] = [returnEndPoints[0][0], returnEndPoints[0][1]];
  mirrored[mirrored.length - 1] = [
    returnEndPoints[returnEndPoints.length - 1][0],
    returnEndPoints[returnEndPoints.length - 1][1],
  ];
  return mirrored;
}

/**
 * Force each outbound/return pair to share one corridor polyline (return =
 * reverse of the better densified leg). Stations[] stay per-direction.
 * `pairs` is [[outKey, returnKey], ...]. Returns how many trains were rewritten.
 */
export function alignPairedPaths(pathsByKey, pairs, { divergeMidKm = 80 } = {}) {
  let rewritten = 0;
  for (const [aKey, bKey] of pairs ?? []) {
    const pathA = pathsByKey.get(aKey);
    const pathB = pathsByKey.get(bKey);
    if (!pathA || pathA.length < 2 || !pathB || pathB.length < 2) continue;
    if (reverseMidpointKm(pathA, pathB) <= divergeMidKm) continue;

    // Prefer the smoother densified leg (smaller worst jump, then more points).
    const aBetter =
      maxSegmentKm(pathA) < maxSegmentKm(pathB) ||
      (maxSegmentKm(pathA) === maxSegmentKm(pathB) && pathA.length >= pathB.length);
    const winnerKey = aBetter ? aKey : bKey;
    const loserKey = aBetter ? bKey : aKey;
    const winner = pathsByKey.get(winnerKey);
    const loserEnds = pathsByKey.get(loserKey);
    const mirrored = mirrorPathForReturn(winner, loserEnds);
    if (!mirrored) continue;
    pathsByKey.set(loserKey, mirrored);
    rewritten++;
  }
  return rewritten;
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
