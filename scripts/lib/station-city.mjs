// scripts/lib/station-city.mjs
// City-level station-name comparison for matching one operator's stop list
// against another's. Every timetable source spells the same station its own
// way — "Praha hl.n." / "Praha-Michle autovlak", "Budapest Keleti" /
// "Budapest-Keleti pu", "München Hbf" / "Muenchen Hbf" — so an exact or even
// diacritic-folded comparison rejects stations that are plainly the same place.
//
// Reducing a name to its leading city token is enough to tell two corridors
// apart, which is all callers need: they are asking "is this the same journey",
// not "is this the same platform".

/**
 * Leading city of a station name, folded so spelling variants converge.
 * @param {string} name
 * @returns {string}
 */
export function stationCity(name) {
  return (
    String(name ?? "")
      .toLowerCase()
      // German umlauts reach us both transliterated ("Muenchen", PLK) and
      // accented ("München", Back-on-Track/GTFS). Collapse both to the bare
      // vowel so they meet: strip the accent first, then the "e" spelling.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/([aou])e(?=[a-z])/g, "$1")
      // Keep only the first word, then cut qualifiers a hyphen or bracket
      // introduces ("Praha-Michle" → praha, "Frankfurt(Oder)" → frankfurt).
      .trim()
      .split(/\s+/)[0]
      .split(/[-(/,]/)[0]
      .replace(/[^\p{L}\p{N}]/gu, "")
  );
}

/** Whether two station names name the same city. */
export function sameCity(a, b) {
  const x = stationCity(a);
  const y = stationCity(b);
  return x.length > 0 && x === y;
}

/** Loose name equality — punctuation and spacing differ between sources. */
function sameStation(a, b) {
  const flat = (s) =>
    String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  const x = flat(a);
  return x.length > 0 && x === flat(b);
}

/**
 * The portion of a stop list that is actually this row's journey.
 *
 * An operator's stop list often runs past the endpoints a row claims — ČD's
 * EN 442 continues from Praha hl.n. to the Praha-Michle car-carrier terminal,
 * so reading the last stop's time would give the row a 08:38 arrival for a
 * journey that ends at 07:26. Prefer the stop actually named by the row, then
 * fall back to the first stop in the same city.
 *
 * @param {{name?: string}[]} stops
 * @param {string} origin
 * @param {string} destination
 * @returns {{name?: string}[] | null} null when the list doesn't cover the journey
 */
export function sliceToJourney(stops, origin, destination) {
  if (!Array.isArray(stops) || stops.length < 2) return null;
  const findFrom = (from, target) => {
    const exact = stops.findIndex((s, i) => i >= from && sameStation(s?.name, target));
    if (exact !== -1) return exact;
    const city = stops.findIndex((s, i) => i >= from && sameCity(s?.name, target));
    return city;
  };
  const start = findFrom(0, origin);
  if (start === -1) return null;
  const end = findFrom(start + 1, destination);
  if (end === -1) return null;
  const slice = stops.slice(start, end + 1);
  return slice.length >= 2 ? slice : null;
}

/**
 * Whether a stop list runs between two named endpoints, in either direction.
 * @param {{name?: string}[]} stops
 * @param {string} origin
 * @param {string} destination
 */
export function stopsRunBetween(stops, origin, destination) {
  if (!Array.isArray(stops) || stops.length < 2) return false;
  const first = stops[0]?.name;
  const last = stops[stops.length - 1]?.name;
  return (
    (sameCity(first, origin) && sameCity(last, destination)) ||
    (sameCity(first, destination) && sameCity(last, origin))
  );
}
