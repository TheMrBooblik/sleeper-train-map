// scripts/lib/sibling-path.mjs
// When an official stop list is sparse, a stops-chain polyline jumps across
// the country in long chords. This module borrows intermediate coordinates
// from denser sibling routes that pass near both ends of a long gap — path
// only, never as visible stations (detail panel / map markers stay clean).
//
// Rule: every official coord station must remain a vertex of the polyline.
// Sibling geometry is only inserted BETWEEN consecutive official stops.

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
 * Keeps every input vertex (official stations). gapKm = min jump to fill.
 * preferredDonors are tried first so outbound/return can share a corridor.
 */
export function densifyPathWithSiblings(
  path,
  siblingPaths,
  { gapKm = 180, matchKm = 70, preferredDonors = [] } = {},
) {
  if (!Array.isArray(path) || path.length < 2) return path ?? [];
  const preferred = (preferredDonors ?? []).filter(
    (p) => Array.isArray(p) && p.length >= 3,
  );
  const donors = (siblingPaths ?? []).filter(
    (p) => Array.isArray(p) && p.length >= 3,
  );
  if (!preferred.length && !donors.length) return path;

  const out = [path[0]];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const gap = haversineKm(a, b);
    let mid = [];
    if (gap > gapKm) {
      mid =
        pickSlice(a, b, preferred, matchKm) ??
        pickSlice(a, b, donors, matchKm) ??
        [];
    }
    out.push(...mid, b);
  }
  return out;
}

function pickSlice(a, b, donors, matchKm) {
  let best = null;
  let bestMax = Infinity;
  let bestFp = null;
  for (const donor of donors) {
    const slice = siblingSliceBetween(a, b, donor, matchKm);
    if (!slice?.length) continue;
    // Prefer the fill that shortens the worst hop the most; tie-break denser,
    // then stable fingerprint so outbound/return pick the same corridor.
    const filledMax = maxSegmentKm([a, ...slice, b]);
    const fp = pathFingerprint(slice);
    if (
      !best ||
      filledMax < bestMax - 0.5 ||
      (Math.abs(filledMax - bestMax) <= 0.5 && slice.length > best.length) ||
      (Math.abs(filledMax - bestMax) <= 0.5 &&
        slice.length === best.length &&
        fp < bestFp)
    ) {
      best = slice;
      bestMax = filledMax;
      bestFp = fp;
    }
  }
  return best;
}

/**
 * Rebuild a polyline that visits every official station in order, borrowing
 * only the guide's geometry between consecutive stops that lie near the guide.
 * Official coords are exact vertices — stations cannot fall off the route.
 */
export function stitchPathThroughStations(
  official,
  guide,
  { matchKm = 80 } = {},
) {
  if (!Array.isArray(official) || official.length < 2) return official ?? [];
  if (!Array.isArray(guide) || guide.length < 2) {
    return official.map((p) => [p[0], p[1]]);
  }

  const out = [[official[0][0], official[0][1]]];
  for (let i = 0; i < official.length - 1; i++) {
    const a = official[i];
    const b = official[i + 1];
    const mid = siblingSliceBetween(a, b, guide, matchKm) ?? [];
    out.push(...mid.map((p) => [p[0], p[1]]), [b[0], b[1]]);
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
 * Align outbound/return onto a shared guide corridor without dropping either
 * train's official stations. Each leg is re-stitched through its own stops.
 * `officialByKey` + `pathsByKey` are Maps of [lat,lon][]; pairs is [[a,b],...].
 */
export function alignPairedPaths(
  pathsByKey,
  pairs,
  officialByKey,
  { divergeMidKm = 80, matchKm = 80, gapKm = 180 } = {},
) {
  let rewritten = 0;
  for (const [aKey, bKey] of pairs ?? []) {
    const pathA = pathsByKey.get(aKey);
    const pathB = pathsByKey.get(bKey);
    const officialA = officialByKey?.get(aKey);
    const officialB = officialByKey?.get(bKey);
    if (!pathA || pathA.length < 2 || !pathB || pathB.length < 2) continue;
    if (!officialA || officialA.length < 2 || !officialB || officialB.length < 2) {
      continue;
    }
    if (reverseMidpointKm(pathA, pathB) <= divergeMidKm) continue;

    // Prefer the smoother densified leg as the shared guide corridor.
    const aBetter =
      maxSegmentKm(pathA) < maxSegmentKm(pathB) ||
      (maxSegmentKm(pathA) === maxSegmentKm(pathB) && pathA.length >= pathB.length);
    const guide = aBetter ? pathA : pathB;
    const guideRev = [...guide].reverse();

    // Re-densify each leg from its OWN official stops, preferring the shared
    // guide — never replace the whole path with reverse(winner).
    const nextA = densifyPathWithSiblings(officialA, [guide, guideRev], {
      gapKm,
      matchKm,
      preferredDonors: [guide, guideRev],
    });
    const nextB = densifyPathWithSiblings(officialB, [guide, guideRev], {
      gapKm,
      matchKm,
      preferredDonors: [guide, guideRev],
    });
    pathsByKey.set(aKey, stitchPathThroughStations(officialA, nextA, { matchKm }));
    pathsByKey.set(bKey, stitchPathThroughStations(officialB, nextB, { matchKm }));
    rewritten += 2;
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

/** Max distance from any official station to the nearest polyline vertex. */
export function maxStationDeviationKm(official, path) {
  if (!official?.length || !path?.length) return Infinity;
  let max = 0;
  for (const pt of official) {
    max = Math.max(max, nearestIdx(path, pt).km);
  }
  return max;
}

function pathKm(path) {
  let km = 0;
  for (let i = 0; i < path.length - 1; i++) km += haversineKm(path[i], path[i + 1]);
  return km;
}

/**
 * A track-shaped path through `stops` (in order) built from the real track of
 * other trains, for a train whose operator sent no route line of its own.
 *
 * nightjet.com answers some journeys with stops and no polyline (NJ 449, the
 * February Brussels–Wien routing via Frankfurt, Würzburg and Passau), and the
 * adapter used to draw those as straight chords between stations. Every gap
 * between two consecutive stops is filled from the donor whose track passes
 * within `matchKm` of BOTH stops and runs between them the shortest way —
 * never more than `maxDetour` times the straight distance, so a donor that
 * reaches B by way of somewhere else cannot lend that detour. A gap no donor
 * covers stays a straight chord, and every stop stays an exact vertex, so a
 * station can never fall off its own line.
 *
 * @param {[number, number][]} stops [lat, lon] per stop, in travel order
 * @param {[number, number][][]} donors other trains' real track paths
 * @returns {{ path: [number, number][], filled: number, gaps: number }}
 */
export function trackPathFromSiblings(stops, donors, { matchKm = 6, maxDetour = 1.8 } = {}) {
  const usable = (donors ?? []).filter((p) => Array.isArray(p) && p.length >= 3);
  if (!Array.isArray(stops) || stops.length < 2) {
    return { path: stops ?? [], filled: 0, gaps: 0 };
  }
  const out = [stops[0]];
  let filled = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const direct = haversineKm(a, b);
    let best = null;
    let bestKm = Infinity;
    for (const donor of usable) {
      const slice = siblingSliceBetween(a, b, donor, matchKm);
      if (!slice?.length) continue;
      const km = pathKm([a, ...slice, b]);
      if (km > direct * maxDetour + 2) continue;
      if (km < bestKm - 0.5 || (Math.abs(km - bestKm) <= 0.5 && slice.length > best.length)) {
        best = slice;
        bestKm = km;
      }
    }
    if (best) filled++;
    out.push(...(best ?? []), b);
  }
  return { path: out, filled, gaps: stops.length - 1 };
}
