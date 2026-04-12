/**
 * Route styling and route-matching helpers for map polylines.
 * Used to determine line weight, dash array, and special cases (e.g. European Sleeper 453).
 */

// BoT calendar window in trip.service_id, e.g. "2026/06/26-2026/08/30: Daily"
const SERVICE_ID_CALENDAR_RANGE_RE =
  /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/;

/**
 * Parse YYYY/MM/DD-YYYY/MM/DD from Back-on-Track service_id (optional ": …" suffix).
 * @param {string} [serviceId]
 * @returns {{ start: Date, end: Date } | null} Local-date start/end (inclusive).
 */
export function parseBoTServiceIdDateRange(serviceId) {
  if (!serviceId || typeof serviceId !== "string") return null;
  const m = serviceId.match(SERVICE_ID_CALENDAR_RANGE_RE);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const end = new Date(Number(m[4]), Number(m[5]) - 1, Number(m[6]));
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return { start, end };
}

/**
 * True when every trip on this route has a calendar service_id range and today is outside all of them.
 * If any trip has no such range (e.g. "2026: Daily"), the route stays visible year-round.
 * @param {string|number} routeId
 * @param {Record<string, object>} trips
 * @returns {boolean}
 */
export function isRouteOutsideServiceIdSeason(routeId, trips) {
  if (!trips || routeId == null) return false;

  const routeTrips = Object.values(trips).filter(
    (trip) => trip.route_id?.toString() === routeId.toString(),
  );
  if (routeTrips.length === 0) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const ranges = [];
  for (const trip of routeTrips) {
    const range = parseBoTServiceIdDateRange(trip.service_id);
    if (!range) {
      return false;
    }
    ranges.push(range);
  }

  const inAny = ranges.some(
    ({ start, end }) => today >= start && today <= end,
  );
  return !inAny;
}

/**
 * Get polyline style (weight, dashArray, opacity) from route frequency in trips.
 * Matches legend: 6-7 days = solid, 3-5 = medium dash, seasonal = dashed + lighter.
 * @param {string} routeId - Route ID
 * @param {Object} trips - Trips data keyed by trip id
 * @returns {{ weight: number, dashArray: string|null, opacity?: number }}
 */
export function getRouteStyleFromFrequency(routeId, trips) {
  if (!trips || !routeId) {
    return { weight: 4.5, dashArray: null };
  }

  const routeTrips = Object.values(trips).filter(
    (trip) => trip.route_id?.toString() === routeId.toString(),
  );

  if (routeTrips.length === 0) {
    return { weight: 4.5, dashArray: null };
  }

  let isSeasonal = false;
  let hasNonDailyNote = false;
  let isDaily = false;
  let isWeekly = false;

  for (const trip of routeTrips) {
    const irr = (trip.irregularities || "").toLowerCase();
    const serviceId = (trip.service_id || "").toLowerCase();

    if (
      serviceId.includes("daily") ||
      serviceId.includes("6-7") ||
      serviceId.includes("every day")
    ) {
      isDaily = true;
    } else if (
      serviceId.includes("3-5") ||
      serviceId.includes("weekdays") ||
      serviceId.includes("mon-fri")
    ) {
      isWeekly = true;
    }

    if (
      irr.includes("seasonal") ||
      irr.includes("summer") ||
      irr.includes("winter") ||
      irr.includes("only") ||
      serviceId.includes("seasonal")
    ) {
      isSeasonal = true;
    }

    if (parseBoTServiceIdDateRange(trip.service_id || "")) {
      isSeasonal = true;
    }

    if (
      irr.includes("non-daily") ||
      irr.includes("non daily") ||
      irr.includes("few times") ||
      irr.includes("limited")
    ) {
      hasNonDailyNote = true;
    }
  }

  if (isDaily && !hasNonDailyNote) {
    return { weight: 4.5, dashArray: null };
  }
  if (isWeekly) {
    return { weight: 4.5, dashArray: "6,9" };
  }
  if (isSeasonal) {
    return {
      weight: 2.5,
      dashArray: "6,6",
      opacity: 0.45,
    };
  }

  const uniqueTrips = new Set(
    routeTrips.map((t) => `${t.trip_origin}-${t.trip_headsign}`),
  ).size;

  if (uniqueTrips >= 6) {
    return { weight: 4.5, dashArray: null };
  }
  if (uniqueTrips >= 3) {
    return { weight: 4.5, dashArray: "6,9" };
  }
  return { weight: 4.5, dashArray: "6,6" };
}

/**
 * Whether the route is European Sleeper 453 (Bruxelles Midi – Praha).
 * Used to switch to OSM relation polyline for accurate geometry.
 * @param {Object} route - View map route object (origin_trip_0, destination_trip_0, etc.)
 * @returns {boolean}
 */
export function checkEuropeanSleeper453(route) {
  if (!route) return false;
  const origin0 = (route.origin_trip_0 || "").toLowerCase();
  const dest0 = (route.destination_trip_0 || "").toLowerCase();
  const origin1 = (route.origin_trip_1 || "").toLowerCase();
  const dest1 = (route.destination_trip_1 || "").toLowerCase();

  const hasBruxelles =
    origin0.includes("bruxelles midi") ||
    origin0.includes("brussel zuid") ||
    dest0.includes("bruxelles midi") ||
    dest0.includes("brussel zuid") ||
    origin1.includes("bruxelles midi") ||
    origin1.includes("brussel zuid") ||
    dest1.includes("bruxelles midi") ||
    dest1.includes("brussel zuid");
  const hasPraha =
    dest0.includes("praha") ||
    dest0.includes("prague") ||
    origin0.includes("praha") ||
    origin0.includes("prague") ||
    dest1.includes("praha") ||
    dest1.includes("prague") ||
    origin1.includes("praha") ||
    origin1.includes("prague");

  return hasBruxelles && hasPraha;
}

/**
 * Whether the route is RegioJet 1020/1021 (Praha – Chop).
 * Detected by agency_id "RJ" and trip names 1020/1021, or by origin/destination matching.
 * Uses combined OSM relations for accurate geometry along the railway tracks.
 * @param {Object} route - View map route object
 * @returns {boolean}
 */
export function checkRegioJetPrahaChop(route) {
  if (!route) return false;

  // Primary check: trip short names 1020 / 1021 with RJ agency
  const trip0 = (route.trip_short_name_0 || "").toString().trim();
  const trip1 = (route.trip_short_name_1 || "").toString().trim();
  const agency = (route.agency_id || "").toUpperCase();
  if (
    agency === "RJ" &&
    (trip0 === "1020" ||
      trip0 === "1021" ||
      trip1 === "1020" ||
      trip1 === "1021")
  ) {
    return true;
  }

  // Fallback: match origin/destination pair (Praha + Chop/Čop)
  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());

  const hasPraha = fields.some((f) => f.includes("praha"));
  const hasChop = fields.some((f) => f.includes("chop") || f.includes("čop"));
  return hasPraha && hasChop;
}

/**
 * Whether the route is RegioJet 1038/1039 (Praha – Przemyśl).
 * Uses a pre-computed polyline built from EN 443 (Praha→Kraków) + IC 8358 (Kraków→Przemyśl).
 * @param {Object} route - View map route object
 * @returns {boolean}
 */
export function checkRegioJetPrahaPrzemysl(route) {
  if (!route) return false;

  const trip0 = (route.trip_short_name_0 || "").toString().trim();
  const trip1 = (route.trip_short_name_1 || "").toString().trim();
  const agency = (route.agency_id || "").toUpperCase();
  if (
    agency === "RJ" &&
    (trip0 === "1038" ||
      trip0 === "1039" ||
      trip1 === "1038" ||
      trip1 === "1039")
  ) {
    return true;
  }

  // Fallback: Praha + Przemyśl with RJ agency
  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());

  const hasPraha = fields.some((f) => f.includes("praha"));
  const hasPrzemysl = fields.some((f) => f.includes("przemy"));
  return agency === "RJ" && hasPraha && hasPrzemysl;
}

/**
 * Whether the route is EN 442/443 (Humenné – Praha).
 * ZSSK-operated night train via Košice, Poprad Tatry, Olomouc.
 * Uses combined OSM relations: Praha→Košice + Košice→Humenné.
 * @param {Object} route - View map route object
 * @returns {boolean}
 */
export function checkENHumennePraha(route) {
  if (!route) return false;

  const trip0 = (route.trip_short_name_0 || "").toString().trim();
  const trip1 = (route.trip_short_name_1 || "").toString().trim();

  // Match "EN 442" or "EN 443" (but not the PKP/ČD Warsaw variant in route 9)
  const isEN442or443 =
    /^EN\s*44[23]$/.test(trip0) || /^EN\s*44[23]$/.test(trip1);
  if (!isEN442or443) return false;

  // Distinguish from the Praha–Warszawa EN 443 (route 9, agency PKP/ČD)
  // by checking for Humenné in origin/destination
  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());

  return fields.some((f) => f.includes("humen"));
}

/**
 * Whether the route is R 680/681 "Zemplín" (Bratislava – Humenné).
 * ZSSK-operated daytime Rychlík via Žilina, Košice, Trebišov, Michalovce.
 * Uses a pre-computed static polyline combining ŽSR 120 + 180 + Košice→Humenné.
 * @param {Object} route - View map route object
 * @returns {boolean}
 */
export function checkZemplinBratislavaHumenne(route) {
  if (!route) return false;
  const trip0 = (route.trip_short_name_0 || "").toString().trim();
  const trip1 = (route.trip_short_name_1 || "").toString().trim();
  if (/^R\s*680$/.test(trip0) || /^R\s*681$/.test(trip0)) return true;
  if (/^R\s*680$/.test(trip1) || /^R\s*681$/.test(trip1)) return true;

  // Fallback: Bratislava + Humenné with ZSSK agency
  const agency = (route.agency_id || "").toUpperCase();
  if (agency !== "ZSSK") return false;
  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());
  return (
    fields.some((f) => f.includes("bratislava")) &&
    fields.some((f) => f.includes("humen"))
  );
}

// Color for the Zemplín Bratislava–Humenné route
export const ZEMPLIN_COLOR = "#D32F2F";

// Color for PKP Intercity routes — navy blue matching PKP IC branding
export const PKP_COLOR = "#003580";

/**
 * PKP / PKP-ČD rows from Back-on-Track; polylines come from GTFS (see useInitialData merge).
 * @param {object} route - viewMap route row
 * @returns {boolean}
 */
export function isPkpAgencyRoute(route) {
  const a = (route?.agency_id || "").toUpperCase();
  return a === "PKP" || a === "PKP/ČD";
}

/**
 * Whether the route belongs to RegioJet (agency_id === "RJ").
 * Used to apply RegioJet brand color (yellow) instead of default palette.
 * @param {Object} route - View map route object
 * @returns {boolean}
 */
export function isRegioJetRoute(route) {
  return (route?.agency_id || "").toUpperCase() === "RJ";
}

// RegioJet brand color – golden yellow matching their train livery
export const REGIOJET_COLOR = "#F0AB00";

/**
 * Hide route in lists/markers when: (1) irregularities have a future "From YYYY-MM-DD", or
 * (2) every trip uses a service_id calendar range (YYYY/MM/DD-YYYY/MM/DD) and today is outside all ranges.
 * Map polylines: future "From" still draw as ghost lines; seasonal-outside routes are omitted (see useRoutePaths).
 * @param {string} routeId - Route ID
 * @param {Object} trips - Trips data
 * @returns {boolean}
 */
export function shouldHideRouteDueToFutureDate(routeId, trips) {
  if (getFutureRouteStartDate(routeId, trips) !== null) return true;
  if (isRouteOutsideServiceIdSeason(routeId, trips)) return true;
  return false;
}

/**
 * If a route has a future "From YYYY-MM-DD" irregularity, returns that date string.
 * Returns null when the route is already running (or date cannot be determined).
 * @param {string} routeId - Route ID
 * @param {Object} trips - Trips data
 * @returns {string|null} "YYYY-MM-DD" or null
 */
export function getFutureRouteStartDate(routeId, trips) {
  if (!trips || !routeId) return null;

  const routeTrips = Object.values(trips).filter(
    (trip) => trip.route_id?.toString() === routeId.toString(),
  );
  if (routeTrips.length === 0) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const trip of routeTrips) {
    const irregularities = trip.irregularities;
    if (!irregularities || typeof irregularities !== "string") continue;

    const match = irregularities.match(/From\s+(\d{4}-\d{2}-\d{2})/i);
    if (match) {
      const fromDate = new Date(match[1]);
      fromDate.setHours(0, 0, 0, 0);
      if (fromDate > today) return match[1]; // "YYYY-MM-DD"
    }
  }
  return null;
}
