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

/** City of a bundle stop object. @param {{name?: string}} stop */
function stopCity(stop) {
  return normalizeCity(stop?.name);
}

/**
 * All corridor variants of a bundle entry: the entry itself plus any
 * `variants` the parser recorded when several distinct trains share one
 * number (e.g. "406" = München→Warszawa AND the Bohumín→Warszawa portion of
 * the Chopin). Selection happens by endpoint validation, not rejection.
 * @param {object|undefined} entry
 * @returns {object[]}
 */
function entryVariants(entry) {
  if (!entry) return [];
  const all = [entry, ...(Array.isArray(entry.variants) ? entry.variants : [])];
  return all.filter((e) => e?.positions?.length >= 2);
}

/**
 * Index of the point in `positions` nearest a [lat, lon] coordinate. Squared
 * degrees are enough to pick the closest vertex among the dense GTFS shape.
 * @param {number[][]} positions
 * @param {number} lat
 * @param {number} lon
 * @returns {number}
 */
function closestPositionIndex(positions, lat, lon) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < positions.length; i += 1) {
    const dLat = positions[i][0] - lat;
    const dLon = positions[i][1] - lon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Truncate one leg to the portion between its start/end junction cities. The
 * polyline is cut at the points nearest the junction stops' coordinates, so the
 * geometry hands off cleanly to the adjacent leg (e.g. keep 35190 only up to
 * Gdynia, not on to Łeba).
 *
 * @param {object} leg  bundle entry
 * @param {string|null} startJunctionCity  null = keep from the real start
 * @param {string|null} endJunctionCity  null = keep to the real end
 * @returns {{ stops: object[], positions: number[][], bus_segments: object[] } | null}
 */
function truncateLeg(leg, startJunctionCity, endJunctionCity) {
  let lo = 0;
  let hi = leg.stops.length - 1;

  if (startJunctionCity) {
    const idx = leg.stops.findIndex((s) => stopCity(s) === startJunctionCity);
    if (idx === -1) return null;
    lo = idx;
  }
  if (endJunctionCity) {
    let idx = -1;
    for (let i = leg.stops.length - 1; i >= lo; i -= 1) {
      if (stopCity(leg.stops[i]) === endJunctionCity) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return null;
    hi = idx;
  }
  if (hi < lo) return null;

  const keptStops = leg.stops.slice(lo, hi + 1);
  const loStop = leg.stops[lo];
  const hiStop = leg.stops[hi];
  let pLo = 0;
  let pHi = leg.positions.length - 1;
  if (startJunctionCity && loStop.lat != null && loStop.lon != null) {
    pLo = closestPositionIndex(leg.positions, loStop.lat, loStop.lon);
  }
  if (endJunctionCity && hiStop.lat != null && hiStop.lon != null) {
    pHi = closestPositionIndex(leg.positions, hiStop.lat, hiStop.lon);
  }
  if (pHi < pLo) return null;

  const keptPositions = leg.positions.slice(pLo, pHi + 1);
  if (keptPositions.length < 2) return null;

  // Keep only bus connectors that stay within this truncated leg (drops the
  // Lębork→Łeba replacement bus once the leg is cut back to Gdynia).
  const keptCities = new Set(keptStops.map((s) => stopCity(s)));
  const keptBus = (leg.bus_segments || []).filter(
    (b) => keptCities.has(normalizeCity(b.from)) && keptCities.has(normalizeCity(b.to)),
  );

  return { stops: keptStops, positions: keptPositions, bus_segments: keptBus };
}

/**
 * Stitch a compound trip label (e.g. "TLK 35190/50191") into one synthetic
 * entry when no single GTFS shape spans the journey. Each train number is a
 * leg; consecutive legs are joined at the city they share (the junction, e.g.
 * Gdynia), truncating each leg's polyline + stops there. Returns null when the
 * legs can't be chained from origin to destination (so the map falls back to
 * station-coord geometry). No per-route hardcoding — the junction is discovered
 * from the overlapping stop cities.
 *
 * @param {string} label
 * @param {Record<string, object>} byTrainKey
 * @param {string} origin
 * @param {string} destination
 * @returns {object | null}
 */
function stitchCompoundEntry(label, byTrainKey, origin, destination) {
  const o = normalizeCity(origin);
  const d = normalizeCity(destination);
  if (!o || !d) return null;

  // Candidate legs: dedup keys; require geometry + named stops. Every corridor
  // variant of a key is a candidate leg — endpoint/junction validation below
  // decides which one actually belongs to this journey.
  const pool = [];
  const seenKeys = new Set();
  for (const k of extractKeysFromTripLabel(label)) {
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    for (const e of entryVariants(byTrainKey[k])) {
      if (e?.stops?.length >= 2) pool.push(e);
    }
  }
  if (pool.length < 2) return null;

  // Build the journey chain: start with the leg that begins at the origin, then
  // repeatedly attach a leg that passes through the chain tail (its junction).
  const startLeg = pool.find((e) => stopCity(e.stops[0]) === o);
  if (!startLeg) return null;

  const legs = [startLeg];
  const junctions = []; // junction city joining legs[i] and legs[i+1]
  const remaining = pool.filter((e) => e !== startLeg);

  let current = startLeg;
  while (stopCity(current.stops[current.stops.length - 1]) !== d) {
    // Hand-off city = the city closest to current's tail that the candidate
    // also serves (current may overshoot the junction, e.g. on to Łeba).
    const junctionWith = (cand) => {
      const candCities = new Set(cand.stops.map((s) => stopCity(s)));
      for (let i = current.stops.length - 1; i >= 0; i -= 1) {
        const c = stopCity(current.stops[i]);
        if (candCities.has(c)) return c;
      }
      return null;
    };

    let chosen = null;
    let junction = null;
    // Pass 1 — clean hand-off: the junction is a natural endpoint of one leg
    // (a train splitting numbers at the junction, e.g. Gdynia for the Hel
    // spur). Preferred because it is unambiguous.
    for (const cand of remaining) {
      const j = junctionWith(cand);
      if (!j) continue;
      const currentEndsAtJunction =
        stopCity(current.stops[current.stops.length - 1]) === j;
      const candStartsAtJunction = stopCity(cand.stops[0]) === j;
      if (!currentEndsAtJunction && !candStartsAtJunction) continue;
      chosen = cand;
      junction = j;
      break;
    }
    // Pass 2 — mid-corridor hand-off: through cars switching between two
    // trains that both continue past the junction (e.g. Przemyśl–Świnoujście
    // cars riding the Berlin train to Poznań, then the Chełm–Świnoujście
    // train onward — Back-on-Track encodes exactly this in compound labels).
    // Safe because the legs come from the SAME label and the finished chain
    // must still start at the route's origin and end at its destination.
    if (!chosen) {
      for (const cand of remaining) {
        const j = junctionWith(cand);
        if (!j) continue;
        chosen = cand;
        junction = j;
        break;
      }
    }
    if (!chosen || !junction) return null;
    junctions.push(junction);
    legs.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
    current = chosen;
    if (legs.length > pool.length) return null; // safety against cycles
  }
  if (legs.length < 2) return null;

  // Truncate each leg at its bounding junctions, then merge.
  const railSegments = [];
  const positions = [];
  const busSegments = [];
  const stops = [];
  const seenStopCity = new Set();

  for (let i = 0; i < legs.length; i += 1) {
    const startJunction = i > 0 ? junctions[i - 1] : null;
    const endJunction = i < legs.length - 1 ? junctions[i] : null;
    const t = truncateLeg(legs[i], startJunction, endJunction);
    if (!t) return null;

    railSegments.push({ positions: t.positions });
    positions.push(...t.positions);
    busSegments.push(...t.bus_segments);
    for (const s of t.stops) {
      const c = stopCity(s);
      if (seenStopCity.has(c)) continue; // dedupe the shared junction stop
      seenStopCity.add(c);
      stops.push(s);
    }
  }
  if (positions.length < 2 || stops.length < 2) return null;

  // Service calendar from the main corridor leg (the one with the most stops).
  let mainLeg = legs[0];
  for (const l of legs) {
    if ((l.stops?.length || 0) > (mainLeg.stops?.length || 0)) mainLeg = l;
  }

  return {
    positions,
    stops,
    rail_segments: railSegments,
    bus_segments: busSegments,
    validFrom: mainLeg.validFrom ?? null,
    validUntil: mainLeg.validUntil ?? null,
    days: mainLeg.days ?? null,
    serviceIds: mainLeg.serviceIds,
  };
}

/**
 * Resolve the single GTFS bundle entry for a BoT trip label, validated against
 * the route's endpoints. Tries each candidate key in priority order and returns
 * the first whose shape endpoints match the route corridor. When no single
 * shape spans the journey, stitches a compound label's legs at their junction
 * (e.g. "TLK 35190/50191" = main corridor + peninsula spur joined at Gdynia);
 * returns null when neither works (so the map falls back to OSM / static /
 * station-coord geometry).
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
    for (const variant of entryVariants(byTrainKey[k])) {
      if (entryMatchesEndpoints(variant, origin, destination)) return variant;
    }
  }
  return stitchCompoundEntry(label, byTrainKey, origin, destination);
}
