/**
 * Whether a stated journey time can be true of the ground it covers.
 *
 * Two endpoint clocks cannot express more than a day, so a journey longer than
 * 24h wraps and the longest trains in the dataset read as the shortest. A trip
 * duration fixes the rows that have a trip; a synthetic row has none and its
 * feed times carry no date, so for those no correct number exists anywhere in
 * the data. What exists is proof the number is wrong: straight-line distance
 * over the stated time.
 *
 * A floor on the duration alone does NOT rule this out, which is the mistake
 * this module exists to stop repeating. The wrapped remainder can be anything
 * from zero to 24h, so a "nothing under four hours" rule catches only the
 * bottom sliver of the range — it passed the California Zephyr at 2 971 km in
 * 5h 31m (539 km/h) and thirteen others. Speed is the test that scales.
 *
 * Dependency-free `.mjs`, so `snippet.mjs` can import it and keep the property
 * its own "no dependencies" rule protects — the same move `format.js` made for
 * `viaSplit.mjs`.
 */

/**
 * Faster than any sleeper runs, straight-line. Night trains average 60–90 km/h
 * over the ground; the fastest legitimate leg in the payload implies 134. At
 * 160 the only thing above the line is a journey time that lost a day.
 */
export const MAX_PLAUSIBLE_KMH = 160;

const EARTH_KM_PER_DEG = 111.32;

/**
 * Straight-line distance between two [lat, lon] points, in km.
 *
 * Equirectangular, matching `distanceKm` in the map's `returnGeometryBranches`
 * — exact enough at these distances, and it UNDERSTATES the track, so a
 * journey this rejects is even faster than the figure says.
 *
 * @param {[number, number]|null|undefined} a
 * @param {[number, number]|null|undefined} b
 * @returns {number} 0 when either point is missing or unreadable
 */
export function greatCircleKm(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const [aLat, aLon] = a.map(Number);
  const [bLat, bLon] = b.map(Number);
  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return 0;
  const dLat = (aLat - bLat) * EARTH_KM_PER_DEG;
  const dLon = (aLon - bLon) * EARTH_KM_PER_DEG * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * True when covering `km` in `minutes` would need more than a sleeper can do.
 *
 * Answers false when it cannot tell — no coordinates, no time — because this
 * is proof a number is wrong, never proof that it is right.
 *
 * @param {number} km
 * @param {number} minutes
 * @returns {boolean}
 */
export function durationIsImplausible(km, minutes) {
  if (!(km > 0) || !(minutes > 0)) return false;
  return km / (minutes / 60) > MAX_PLAUSIBLE_KMH;
}
