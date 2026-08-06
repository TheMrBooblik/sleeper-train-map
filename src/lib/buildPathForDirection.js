// src/lib/buildPathForDirection.js
// Shared "chain station coordinates into a route line" helper.
//
// useRoutePaths.js (selected-route mode) and buildAllRoutesPaths.js (show-all
// mode) used to each carry their own copy of this algorithm. A geometry fix
// landing in only one of them made the line look different depending on
// whether a station was selected. One shared function closes that gap.
//
// The line is origin → each via → destination. A name that does not resolve
// is skipped silently (the line shortcuts across it) — that is exactly why
// PLK station names must be canonicalized onto the stop table before they
// land in via_*.

/**
 * @param {string} origin
 * @param {string} destination
 * @param {string|null|undefined} viaStations  "A - B - C" intermediate names
 * @param {(name: string) => [number, number]|null} findStationCoords
 * @param {(name: string) => boolean} isStationSkipped
 * @returns {Array<[number, number]>|null}  null when fewer than 2 points resolve
 */
export function buildPathForDirection(
  origin,
  destination,
  viaStations,
  findStationCoords,
  isStationSkipped,
) {
  if (isStationSkipped(origin) || isStationSkipped(destination)) return null;
  const sequence = [];
  if (origin && !isStationSkipped(origin)) {
    const c = findStationCoords(origin);
    if (c) sequence.push(c);
  }
  if (viaStations) {
    viaStations
      .split(" - ")
      .map((s) => s.trim())
      .forEach((via) => {
        if (!isStationSkipped(via)) {
          const c = findStationCoords(via);
          if (c) sequence.push(c);
        }
      });
  }
  if (destination && !isStationSkipped(destination)) {
    const c = findStationCoords(destination);
    if (c) sequence.push(c);
  }
  return sequence.length >= 2 ? sequence : null;
}
