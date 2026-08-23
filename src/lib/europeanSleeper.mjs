// src/lib/europeanSleeper.mjs
// Which trip may read the European Sleeper feed, and which of its two timetable
// periods it reads.
//
// The feed (public/data/scraped/europeansleeper-trains.json) is keyed by BARE
// train number — "400", "452", "474" — because that is the shape Back-on-Track's
// trip_short_name comes in. A bare number is only unique WITHIN an operator, and
// Back-on-Track carries a CFM/CFR 401 (Chişinău–București) and an SJN 475
// (Trondheim–Bodø) alongside European Sleeper's ES 401/475. Looking the feed up
// by number alone therefore dressed those two trains in European Sleeper's
// stops, endpoints, duration and service days.
//
// The scrape side already guards this with `synthetic.botMatchAgencies` in
// data/sources/registry.json; this is the same rule for the render side.
//
// `.mjs` so raw-node tests can import it — the detail panel is a 1700-line JSX
// component and nothing in it is reachable from a unit suite.

/** Synthetic rows built entirely from the feed: `es_400`, `es_400_from_20261214`. */
export function isEuropeanSleeperRoute(routeId) {
  return String(routeId || "").startsWith("es_");
}

/**
 * Whether this trip is European Sleeper's.
 *
 * Two shapes qualify: the synthetic `es_` rows, and the Back-on-Track rows the
 * feed only enriches — those keep BoT's numeric route ids (237, 238) and carry
 * the operator on the trip, so the agency is what identifies them.
 */
export function isEuropeanSleeperTrip(trip) {
  return (
    isEuropeanSleeperRoute(trip?.route_id) ||
    String(trip?.agency_id || "").trim().toUpperCase() === "ES"
  );
}

/**
 * A route the feed knows replaces the current one at the next timetable change
 * (build-initial-data appends `_from_YYYYMMDD`). It reuses the same train
 * numbers, so its timetable has to be looked up in the other period's map.
 */
export function isUpcomingTimetableRoute(routeId) {
  return String(routeId || "").includes("_from_");
}

/**
 * The feed's schedule for a trip, or null when the feed has no claim on it.
 *
 * @param {object} trip                      a rendered trip row
 * @param {{current: Map, upcoming: Map}} maps  schedules by bare train number
 * @param {string} trainNumber               the trip's normalized train number
 * @returns {object|null}
 */
export function esScheduleForTrip(trip, maps, trainNumber) {
  if (!isEuropeanSleeperTrip(trip)) return null;
  const period = isUpcomingTimetableRoute(trip?.route_id)
    ? maps?.upcoming
    : maps?.current;
  return period?.get(trainNumber) || null;
}
