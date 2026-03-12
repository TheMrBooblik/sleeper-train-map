/**
 * Route styling and route-matching helpers for map polylines.
 * Used to determine line weight, dash array, and special cases (e.g. European Sleeper 453).
 */

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

    if (
      /\d{4}\/\d{1,2}\/\d{1,2}\s*-\s*\d{4}\/\d{1,2}\/\d{1,2}/.test(serviceId)
    ) {
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

// ──── PKP Poland detection functions ────
// All 11 PKP routes in the Back-on-Track viewMapData that need static polylines.
// Detection is based on route_long_name since each PKP route has a unique name.
// Trip short names (TLK xxxxx / IC xxxxx) are used as a secondary check.

/**
 * Route 121: Karkonosze — Warszawa→Szklarska Poręba via Wrocław, Jelenia Góra
 * IC 16170 / IC 61170
 */
export function checkPkpKarkonosze(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("karkonosze")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "IC 16170" || t1 === "IC 61170";
}

/**
 * Route 122: Podhalanin — Zakopane→Szczecin via Bielsko-Biała, Katowice, Poznań
 * IC 38192 / IC 83192
 */
export function checkPkpPodhalanin(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("podhalanin")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "IC 38192" || t1 === "IC 83192";
}

/**
 * Route 126: Przemyślanin — Przemyśl→Świnoujście via Kraków, Katowice, Poznań, Szczecin
 * IC 38172 / IC 83172
 */
export function checkPkpUrsa(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("przemy") && name.includes("lanin")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "IC 38172" || t1 === "IC 83172";
}

/**
 * Route 128: Uznam — Warszawa→Świnoujście via Szczecin
 * TLK 18170 / TLK 81170
 */
export function checkPkpUznam(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("uznam")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "TLK 18170" || t1 === "TLK 81170";
}

/**
 * Route 129: Karpaty — Zakopane→Gdynia via Kraków, Warszawa, Gdańsk
 * TLK 35170 / TLK 53170
 */
export function checkPkpKarpaty(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("karpaty")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "TLK 35170" || t1 === "TLK 53170";
}

/**
 * Route 136: Pirat — Bielsko-Biała→Kołobrzeg via Rybnik, Opole
 * TLK 48190 / TLK 84190
 */
export function checkPkpPirat(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("pirat")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "TLK 48190" || t1 === "TLK 84190";
}

/**
 * Route 137: Wolin — Bielsko-Biała→Świnoujście via Rybnik, Opole, Szczecin
 * TLK 46174/38174 / TLK 83174/64174
 */
export function checkPkpWolin(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("wolin")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return /^TLK\s+(46174|38174)/.test(t0) || /^TLK\s+(83174|64174)/.test(t1);
}

/**
 * Route 138: Ustronie — Kraków→Kołobrzeg via Kielce, Radom, Gdańsk
 * TLK 38170 / TLK 83170
 */
export function checkPkpUstronie(route) {
  if (!route) return false;
  const name = (route.route_long_name || "").toLowerCase();
  if (name.includes("ustronie")) return true;
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  return t0 === "TLK 38170" || t1 === "TLK 83170";
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
 * Whether to hide a route because it has a future "From <Date>" note in irregularities.
 * @param {string} routeId - Route ID
 * @param {Object} trips - Trips data
 * @returns {boolean}
 */
export function shouldHideRouteDueToFutureDate(routeId, trips) {
  return getFutureRouteStartDate(routeId, trips) !== null;
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
