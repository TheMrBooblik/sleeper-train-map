/**
 * The corroborated half of a route row, for surfaces that would otherwise render
 * the Back-on-Track trip.
 *
 * Enrichment corrects the ROW — endpoint times, stop list, service days — and
 * never touches the trips table, which is the upstream Back-on-Track export. So
 * a surface reading `trip.origin_departure_time` renders precisely the value an
 * official feed replaced. Across the published payload that is 18 directions
 * disagreeing on a time, worst 183 minutes (IC Nuit 3750: Back-on-Track 19:44
 * where the SNCF export says 22:47, and 3 of the worst 8 are European Sleeper,
 * 62-76 minutes out), plus 52 directions whose trip `via` is 2-5 stops against
 * the row's 6-16. The map's detail panel showed all of it while the map line,
 * the bottom bar and the connection page showed the corrected values.
 *
 * `official_sources` is the flag to read, and it means what is needed here
 * exactly: enrichment stamps it only on a row whose feed trip it actually took
 * (`takesFeedTrip` in enrich-view-map.mjs), so a row where the feed's portion
 * was refused — the two Paris-Aurillac stubs — is unstamped and keeps
 * Back-on-Track's everything, and this returns null for it.
 *
 * `routeDurationMinutes()` in src/lib/seo/format.js already applies this rule to
 * duration alone. This is the rule for the rest of the record, as one shared
 * function so the panel and the connection pages cannot disagree about one
 * train — the same reason `viaScheduleForTrip` is shared rather than duplicated.
 *
 * Dependency-free `.mjs`: raw-node testable, importable from a React component
 * and a build script alike.
 */

/** Minutes since midnight for a bare "HH:MM", else null. */
function minutesOf(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours % 24) * 60 + minutes;
}

/**
 * Journey length from the row's own two endpoint times, wrapping past midnight —
 * which is the only arithmetic a night train ever needs. Deliberately measured
 * rather than read: the trip's `duration` is Back-on-Track's, computed from the
 * times the enrichment replaced, so on a corrected row it contradicts the two
 * numbers printed beside it.
 */
export function durationMinutesBetween(departure, arrival) {
  const from = minutesOf(departure);
  const to = minutesOf(arrival);
  if (from === null || to === null) return null;
  return to >= from ? to - from : to + 1440 - from;
}

/** "11h 27m", or "" when either end is missing. */
export function formatDurationShort(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}

/**
 * @param {object|null} route      a viewMap row
 * @param {number|string} direction  the trip's direction_id (anything but 1 reads as 0,
 *   matching how resolveScheduleLink already maps a trip onto the row's suffixes)
 * @returns {{sources: string[], departure: string|null, arrival: string|null,
 *   via: string|null, serviceDays: string|null, durationMinutes: number|null,
 *   durationText: string}|null} null when the row was never corroborated.
 */
export function officialRowSchedule(route, direction) {
  if (!route) return null;
  const sources = route.official_sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const d = Number(direction) === 1 ? 1 : 0;
  // Times arrive as bare "HH:MM" (enrich-view-map's toHHMM writes them), unlike
  // the trips table's "1899-12-30T20:51:00.000Z" — so they render directly, the
  // way the PKP, Amtrak/VIA and European Sleeper values already do.
  const departure = route[`origin_departure_time_${d}`] || null;
  const arrival = route[`destination_arrival_time_${d}`] || null;
  const via = route[`via_${d}`] || null;
  const serviceDays = route[`service_id_${d}`] || null;
  if (!departure && !arrival && !via && !serviceDays) return null;

  const durationMinutes = durationMinutesBetween(departure, arrival);
  return {
    sources,
    departure,
    arrival,
    via,
    serviceDays,
    durationMinutes,
    durationText: formatDurationShort(durationMinutes),
  };
}
