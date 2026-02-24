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
 * Whether to hide a route because it has a future "From <Date>" note in irregularities.
 * @param {string} routeId - Route ID
 * @param {Object} trips - Trips data
 * @returns {boolean}
 */
export function shouldHideRouteDueToFutureDate(routeId, trips) {
  if (!trips || !routeId) return false;

  const routeTrips = Object.values(trips).filter(
    (trip) => trip.route_id?.toString() === routeId.toString(),
  );
  if (routeTrips.length === 0) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const trip of routeTrips) {
    const irregularities = trip.irregularities;
    if (!irregularities || typeof irregularities !== "string") continue;

    const fromDateMatch = irregularities.match(
      /From\s+(\d{4}-\d{2}-\d{2})/i,
    );
    if (fromDateMatch) {
      const fromDate = new Date(fromDateMatch[1]);
      fromDate.setHours(0, 0, 0, 0);
      if (fromDate > today) return true;
    }
  }
  return false;
}
