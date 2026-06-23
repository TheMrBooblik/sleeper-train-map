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

  const inAny = ranges.some(({ start, end }) => today >= start && today <= end);
  if (inAny) return false;

  // Not running today. Only hide routes whose whole season has already PASSED.
  // A route whose season is still upcoming (e.g. a summer-only train before its
  // start date) stays visible as a "future" ghost with a start-date label —
  // see getFutureRouteStartDate, which reads the same service_id range.
  const anyUpcoming = ranges.some(({ start }) => today < start);
  if (anyUpcoming) return false;

  return true;
}

/** @typedef {0|1|2} FrequencyRank 0=daily, 1=subdaily, 2=rare */

/**
 * Base polyline visuals for map legend — must match `styleFromFrequencyRank`
 * (non-seasonal) and the future-route ghost style in `useRoutePaths` / `buildAllRoutesPaths`.
 * If you change dash/weight on the map, update these so the legend stays accurate.
 */
export const MAP_LEGEND_LINE_BASE_STYLES = {
  /** FrequencyRank 0 — daily service */
  rank0: { weight: 4.5, dashArray: null },
  /** FrequencyRank 1 — less than daily */
  rank1: { weight: 4.2, dashArray: "10,5" },
  /** FrequencyRank 2 — infrequent (~weekly patterns in BoT text) */
  rank2: { weight: 2.75, dashArray: "8,5" },
  /**
   * Not-yet-running routes ("From YYYY-MM-DD", postponed, or an upcoming season).
   * Only the lowered opacity marks them as future — weight and dash still encode
   * frequency exactly like a running route (see useRoutePaths / buildAllRoutesPaths,
   * which apply just `.opacity`). The legend therefore shows a faded daily line.
   */
  futureGhost: { weight: 4.5, dashArray: null, opacity: 0.35 },
};

/**
 * Infer one trip's cadence rank from BoT `service_id` + `irregularities`.
 * Returns null when neither field gives a usable signal (caller may substitute a fallback).
 * @param {object} trip
 * @returns {FrequencyRank|null}
 */
export function inferTripFrequencyRank(trip) {
  if (!trip || typeof trip !== "object") return null;

  const irr = (trip.irregularities || "").toString().toLowerCase();
  const sid = (trip.service_id || "").toString().toLowerCase();
  const blob = `${sid} ${irr}`;

  // Irregularities that explicitly mean "not every day" — at least sub-daily.
  // Use \blimited\b so "unlimited" is not treated as limited service.
  const explicitNonDailyNote =
    irr.includes("non-daily") ||
    irr.includes("non daily") ||
    irr.includes("few times") ||
    /\blimited\b/.test(irr);

  // Rare: about 1–2 runs per week (tight phrases to avoid false positives in long irr text).
  const rareWeek =
    /\bonce\s+(a\s+)?week\b/.test(blob) ||
    /\bonce\s+per\s+week\b/.test(blob) ||
    /\btwice\s+(a\s+)?week\b/.test(blob) ||
    /\btwice\s+per\s+week\b/.test(blob) ||
    /\b1\s*[x×]\s*(\/|\s)?\s*(per\s*)?(week|wk)\b/.test(blob) ||
    /\b2\s*[x×]\s*(\/|\s)?\s*(per\s*)?(week|wk)\b/.test(blob) ||
    /\b1\s*\/\s*week\b/.test(blob) ||
    /\b2\s*\/\s*week\b/.test(blob) ||
    /\b1x\s*\/\s*week\b/.test(blob) ||
    /\b2x\s*\/\s*week\b/.test(blob) ||
    /\bfortnight/.test(blob) ||
    /\bbi-?weekly\b/.test(blob);

  if (rareWeek) return 2;

  // Fewer than seven calendar days per week (not the rare tier above).
  const subDailyText =
    sid.includes("3-5") ||
    sid.includes("3–5") ||
    sid.includes("weekdays") ||
    sid.includes("mon-fri") ||
    sid.includes("mon–fri") ||
    sid.includes("weekend") ||
    sid.includes("weekends") ||
    /\bsat(\.|urday)?\b/.test(sid) ||
    /\bsun(\.|day)?\b/.test(sid) ||
    sid.includes("6 days");

  if (subDailyText || explicitNonDailyNote) return 1;

  // Daily: explicit seven-day style service in service_id (not irregularities alone).
  const dailyService =
    sid.includes("daily") ||
    sid.includes("6-7") ||
    sid.includes("every day") ||
    /\b7\s*days?\b/.test(sid);

  if (dailyService) return 0;

  return null;
}

/**
 * When all trips are text-unknown, use distinct (origin, headsign) count as a weak signal.
 * Never returns 0 (solid): ambiguous rows default to dashed per product rules.
 * @param {object[]} routeTrips
 * @returns {FrequencyRank}
 */
function fallbackRankFromUniqueTripPatterns(routeTrips) {
  const uniqueTrips = new Set(
    routeTrips.map((t) => `${t.trip_origin}-${t.trip_headsign}`),
  ).size;
  if (uniqueTrips <= 2) return 2;
  return 1;
}

/**
 * Route-level rank: worst (highest) cadence among trips. Unknown trips count as at least
 * sub-daily so a single "Daily" label cannot mask another row with no text.
 * @param {object[]} routeTrips
 * @returns {{ rank: FrequencyRank, isSeasonal: boolean }}
 */
function inferRouteFrequencyRank(routeTrips) {
  let isSeasonal = false;
  for (const trip of routeTrips) {
    const irr = (trip.irregularities || "").toString().toLowerCase();
    const sid = (trip.service_id || "").toString().toLowerCase();
    if (
      irr.includes("seasonal") ||
      irr.includes("summer") ||
      irr.includes("winter") ||
      irr.includes("only") ||
      sid.includes("seasonal")
    ) {
      isSeasonal = true;
    }
    if (parseBoTServiceIdDateRange(trip.service_id || "")) {
      isSeasonal = true;
    }
  }

  const perTrip = routeTrips.map((t) => inferTripFrequencyRank(t));
  const fallback = fallbackRankFromUniqueTripPatterns(routeTrips);
  const effective = perTrip.map((r) =>
    r === null ? Math.max(1, fallback) : r,
  );
  const rank = /** @type {FrequencyRank} */ (Math.max(0, ...effective));

  return { rank, isSeasonal };
}

/**
 * Map frequency rank (+ seasonal hint) to Leaflet polyline options.
 * Cadence wins over "seasonal ghost": daily-in-window stays solid; seasonal + sub-daily adds slight fade.
 * @param {FrequencyRank} rank
 * @param {boolean} isSeasonal
 * @returns {{ weight: number, dashArray: string|null, opacity?: number }}
 */
function styleFromFrequencyRank(rank, isSeasonal) {
  if (rank === 0) {
    const base = MAP_LEGEND_LINE_BASE_STYLES.rank0;
    return { weight: base.weight, dashArray: base.dashArray };
  }
  if (rank === 1) {
    const base = MAP_LEGEND_LINE_BASE_STYLES.rank1;
    return {
      weight: base.weight,
      dashArray: base.dashArray,
      ...(isSeasonal ? { opacity: 0.78 } : {}),
    };
  }
  const base = MAP_LEGEND_LINE_BASE_STYLES.rank2;
  return {
    weight: base.weight,
    dashArray: base.dashArray,
    ...(isSeasonal ? { opacity: 0.55 } : {}),
  };
}

/**
 * Get polyline style (weight, dashArray, opacity) from route frequency in trips.
 * Solid only when every trip resolves to daily; any rarer trip forces dashes (worst wins).
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

  const { rank, isSeasonal } = inferRouteFrequencyRank(routeTrips);
  const style = styleFromFrequencyRank(rank, isSeasonal);
  return {
    weight: style.weight,
    dashArray: style.dashArray,
    opacity: style.opacity ?? 0.92,
  };
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

/**
 * Whether the route is the Przemyśl Gł. ↔ Świnoujście PKP overnight train.
 * BoT trip label "EN 430 / IC 28170" causes the wrong GTFS shape (Chełm corridor) to be
 * picked — use a pre-computed static polyline instead.
 * @param {Object} route
 * @returns {boolean}
 */
export function checkPrzemyslSwinoujscie(route) {
  if (!route) return false;
  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());
  return (
    fields.some((f) => f.includes("przemyśl") || f.includes("przemysl")) &&
    fields.some((f) => f.includes("winouj"))
  );
}

/**
 * Whether the route is Warszawa Wschodnia ↔ Budapest Nyugati (Báthory corridor).
 *
 * We match primarily by train numbers in Back-on-Track `trip_short_name_*`.
 * In the current BoT dataset this corridor appears as:
 * - "IC 407 / EN 477" and "EN 476 / IC 406" (route_id 127, agency MÁV/PKP)
 *
 * The user also requested applying the same geometry to EC 131 / EN 407 variants,
 * so we accept those too. To avoid accidental matches on unrelated plain "406/407/131"
 * labels, we additionally require Warszawa + Budapest to appear in origin/destination.
 *
 * @param {Object} route - View map route object
 * @returns {boolean}
 */
export function checkWarszawaBudapestRoute(route) {
  if (!route) return false;

  const t0 = (route.trip_short_name_0 || "").toString();
  const t1 = (route.trip_short_name_1 || "").toString();
  const tripBlob = `${t0} ${t1}`.toUpperCase();

  // Accept these train-number signatures (string may include multiple labels like "IC 407 / EN 477").
  const hasWantedTrip =
    /\bIC\s*40[67]\b/.test(tripBlob) ||
    /\bEN\s*40[67]\b/.test(tripBlob) ||
    /\bEN\s*47[67]\b/.test(tripBlob) ||
    /\bEC\s*131\b/.test(tripBlob);
  if (!hasWantedTrip) return false;

  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toString().toLowerCase());

  const hasWarszawa = fields.some((f) => f.includes("warszawa"));
  const hasBudapest = fields.some((f) => f.includes("budapest"));

  return hasWarszawa && hasBudapest;
}

// Color for the Zemplín Bratislava–Humenné route
export const ZEMPLIN_COLOR = "#D32F2F";

// Color for PKP Intercity routes — navy blue matching PKP IC branding
export const PKP_COLOR = "#003580";

// Bus/local-train replacement segments on PKP routes — orange, matches common bus indicator convention
export const PKP_BUS_COLOR = "#E87722";

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
 * Hide route in lists/markers when every trip uses a service_id calendar range
 * (YYYY/MM/DD-YYYY/MM/DD) and today is outside all ranges.
 * Future routes (those with a "From YYYY-MM-DD" or "Postponed to YYYY" date) are
 * shown as normal lines; the tooltip carries the "opens [date]" text.
 * @param {string} routeId - Route ID
 * @param {Object} trips - Trips data
 * @returns {boolean}
 */
export function shouldHideRouteDueToFutureDate(routeId, trips) {
  if (isRouteOutsideServiceIdSeason(routeId, trips)) return true;
  return false;
}

/**
 * If a route has a future irregularity date, returns that date string.
 * Supports:
 * - "From YYYY-MM-DD"
 * - postponed notes with year, e.g. "postponed to 2027" (normalized to YYYY-01-01)
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
  let earliestFutureDate = null;
  let earliestFutureDateText = null;

  for (const trip of routeTrips) {
    const irregularities = trip.irregularities;
    if (!irregularities || typeof irregularities !== "string") continue;

    const fromDateMatches = irregularities.matchAll(
      /From\s+(\d{4}-\d{2}-\d{2})/gi,
    );
    for (const match of fromDateMatches) {
      const fromDate = new Date(match[1]);
      fromDate.setHours(0, 0, 0, 0);
      if (
        fromDate > today &&
        (earliestFutureDate === null || fromDate < earliestFutureDate)
      ) {
        earliestFutureDate = fromDate;
        earliestFutureDateText = match[1]; // "YYYY-MM-DD"
      }
    }

    const postponedYearMatch = irregularities.match(
      /postpon\w*[^0-9]{0,40}(20\d{2})/i,
    );
    if (postponedYearMatch) {
      const postponedDateText = `${postponedYearMatch[1]}-01-01`;
      const postponedDate = new Date(postponedDateText);
      postponedDate.setHours(0, 0, 0, 0);
      if (
        postponedDate > today &&
        (earliestFutureDate === null || postponedDate < earliestFutureDate)
      ) {
        earliestFutureDate = postponedDate;
        earliestFutureDateText = postponedDateText;
      }
    }
  }

  // Fallback: seasonal routes encode their start in the service_id range
  // (e.g. "2026/06/26-2026/08/30: Daily") rather than an "From …" note. If the
  // route is not running yet and its whole season is upcoming, treat the
  // earliest range start as the start date so it shows as a future ghost.
  if (earliestFutureDateText === null) {
    const ranges = routeTrips
      .map((trip) => parseBoTServiceIdDateRange(trip.service_id))
      .filter(Boolean);
    const runningNow = ranges.some(
      ({ start, end }) => today >= start && today <= end,
    );
    if (!runningNow) {
      for (const { start } of ranges) {
        if (
          start > today &&
          (earliestFutureDate === null || start < earliestFutureDate)
        ) {
          earliestFutureDate = start;
          const y = start.getFullYear();
          const m = String(start.getMonth() + 1).padStart(2, "0");
          const d = String(start.getDate()).padStart(2, "0");
          earliestFutureDateText = `${y}-${m}-${d}`;
        }
      }
    }
  }

  return earliestFutureDateText;
}

/**
 * True when two coordinate paths trace the same line in opposite order — i.e.
 * one is the other reversed (a route's return direction over identical track).
 * Stacking such duplicates makes dashed lines look solid (the dashes interleave
 * and fill each other's gaps) and doubles the stroke opacity, so the route
 * renderers draw only one of the pair. Coordinates compare exactly because both
 * directions resolve the same station coordinates from one shared lookup.
 * @param {Array<[number, number]>} a
 * @param {Array<[number, number]>} b
 * @returns {boolean}
 */
export function arePositionsReverseEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const n = a.length;
  if (n < 2 || n !== b.length) return false;
  for (let i = 0; i < n; i++) {
    const p = a[i];
    const q = b[n - 1 - i];
    if (!p || !q || p[0] !== q[0] || p[1] !== q[1]) return false;
  }
  return true;
}
