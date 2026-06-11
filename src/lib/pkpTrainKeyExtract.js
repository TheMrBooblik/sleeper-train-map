/**
 * Derive GTFS train-number lookup keys from a Back-on-Track trip label
 * (trip_short_name / trip_short_name_0 / _1). Order matters: prefer IC, then TLK,
 * slash-suffixed numbers, EN/EC, then any 4–6 digit run (for compound labels).
 *
 * Used by the PKP GTFS parse script and by the API when attaching polylines to viewMap.
 */

/**
 * @param {string} label
 * @returns {string[]}
 */
export function extractKeysFromTripLabel(label) {
  const s = String(label || "");
  const keys = [];
  /** @param {string} k */
  const push = (k) => {
    if (k && !keys.includes(k)) keys.push(k);
  };

  const ic = s.match(/\bIC\s+(\d{3,6})\b/i);
  if (ic) push(ic[1]);

  const tlk = s.match(/\bTLK\s+(\d{3,6})\b/i);
  if (tlk) push(tlk[1]);

  const slash = s.match(/\/(\d{3,6})(?:\D|$)/);
  if (slash) push(slash[1]);

  const en = s.match(/\bEN\s+(\d{3,6})\b/i);
  if (en) push(en[1]);

  const ec = s.match(/\bEC\s+(\d{3,6})\b/i);
  if (ec) push(ec[1]);

  const longRuns = s.match(/\d{4,6}/g) || [];
  longRuns.forEach((n) => push(n));

  return keys;
}

/**
 * Reduce a station name to its leading "city" token, folded to plain ASCII, so
 * Back-on-Track spellings ("Kraków Gł.", "Praha hl.n.") and GTFS spellings
 * ("Kraków Główny", "Praha hlavní nádraží") compare equal. We keep only the
 * first token because city + suffix variants are the common difference and the
 * city alone is enough to tell two different corridors apart.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeCity(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .split(/\s+/)[0]
    .replace(/[^\p{L}\p{N}-]/gu, "");
}

/**
 * True when a GTFS entry's two endpoints are the same two cities as a BoT
 * route's origin and destination (order-independent). This rejects shapes that
 * a reused train number accidentally matches but that actually serve a
 * different corridor (e.g. IC 406 = München↔Warszawa vs the Praha↔Warszawa
 * route, or IC 28170 = Chełm↔Świnoujście vs the Przemyśl↔Świnoujście route).
 *
 * @param {{ stops?: {name?: string}[] }} entry
 * @param {string} origin
 * @param {string} destination
 * @returns {boolean}
 */
function entryMatchesEndpoints(entry, origin, destination) {
  const stops = entry?.stops;
  if (!stops || stops.length < 2) return false;
  const a = normalizeCity(stops[0]?.name);
  const b = normalizeCity(stops[stops.length - 1]?.name);
  const o = normalizeCity(origin);
  const d = normalizeCity(destination);
  if (!a || !b || !o || !d) return false;
  return (a === o && b === d) || (a === d && b === o);
}

/**
 * Resolve the single GTFS bundle entry for a BoT trip label, validated against
 * the route's endpoints. Tries each candidate key in priority order and returns
 * the first whose shape endpoints match the route corridor; returns null when
 * none match (so the map falls back to OSM / static / station-coord geometry).
 *
 * @param {string} label  e.g. "EN 430 / IC 28170"
 * @param {Record<string, object>} byTrainKey
 * @param {string} origin  BoT route origin for this direction
 * @param {string} destination  BoT route destination for this direction
 * @returns {object | null}  the matched bundle entry
 */
export function pkpEntryForRoute(label, byTrainKey, origin, destination) {
  if (!byTrainKey) return null;
  for (const k of extractKeysFromTripLabel(label)) {
    const entry = byTrainKey[k];
    if (!(entry?.positions?.length >= 2)) continue;
    if (entryMatchesEndpoints(entry, origin, destination)) return entry;
  }
  return null;
}
