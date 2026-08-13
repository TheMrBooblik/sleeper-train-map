/**
 * Station name corrections applied to route data (viewMap), trips, and stops.
 *
 * The data lives in data/overrides/station-name-replacements.json so it can be
 * edited through the admin panel and committed as a structured override:
 *   routeReplacements: { "old name": { newName, routeIds?, agencies? } | "new name" }
 *   stopReplacements:   { "old name": "new name" }
 */
import replacements from "../../data/overrides/station-name-replacements.json" with { type: "json" };

export const stationNameReplacements = replacements.routeReplacements;
export const stopNameReplacements = replacements.stopReplacements;

/**
 * Decide whether this station name should be rewritten for this route.
 * String entries apply everywhere. Object entries may limit by agency_id
 * and/or route_id (both must match when both are set).
 *
 * @param {string} stationName
 * @param {{ routeId?: string|number|null, agencyId?: string|null }} ctx
 * @returns {string|null} new name, or null to keep the original
 */
function shouldReplaceStation(stationName, ctx = {}) {
  const replacement = stationNameReplacements[stationName];
  if (!replacement) return null;

  if (typeof replacement === "string") return replacement;

  const agencies = Array.isArray(replacement.agencies) ? replacement.agencies : null;
  if (agencies && agencies.length > 0) {
    if (!ctx.agencyId || !agencies.includes(ctx.agencyId)) return null;
  }

  const routeIds = Array.isArray(replacement.routeIds) ? replacement.routeIds : null;
  if (routeIds && routeIds.length > 0) {
    const rid = ctx.routeId == null ? "" : String(ctx.routeId);
    const hit = routeIds.some((id) => String(id) === rid);
    if (!hit) return null;
  }

  return replacement.newName || null;
}

/** Rewrite a station field: exact match, or each " - "-separated via stop. */
function replaceStationField(value, ctx) {
  if (typeof value !== "string" || !value) return value;
  const exact = shouldReplaceStation(value, ctx);
  if (exact) return exact;
  return value
    .split(" - ")
    .map((part) => shouldReplaceStation(part.trim(), ctx) || part)
    .join(" - ");
}

/**
 * Apply station name replacements to a viewMap route row.
 * @param {Object} route
 * @returns {Object}
 */
export function applyStationNameReplacements(route) {
  if (!route || typeof route !== "object") return route;

  const ctx = {
    routeId: route.route_id ?? route.routeId ?? null,
    agencyId: route.agency_id ?? null,
  };
  const replacedRoute = { ...route };
  for (const field of [
    "origin_trip_0",
    "destination_trip_0",
    "origin_trip_1",
    "destination_trip_1",
    "via_0",
    "via_1",
  ]) {
    if (replacedRoute[field]) {
      replacedRoute[field] = replaceStationField(replacedRoute[field], ctx);
    }
  }
  // After an endpoint rename (e.g. Flughafen → Süd), a GTFS via list built
  // against the old name can still start/end with the new terminus. Drop those.
  replacedRoute.via_0 = dropViaEndpoints(
    replacedRoute.via_0,
    replacedRoute.origin_trip_0,
    replacedRoute.destination_trip_0,
  );
  replacedRoute.via_1 = dropViaEndpoints(
    replacedRoute.via_1,
    replacedRoute.origin_trip_1,
    replacedRoute.destination_trip_1,
  );
  return replacedRoute;
}

/** Strip via stops that duplicate the origin or destination. */
function dropViaEndpoints(via, origin, dest) {
  if (typeof via !== "string" || !via) return via;
  const norm = (s) => (s || "").toLowerCase().trim();
  let parts = via.split(" - ");
  if (parts.length && norm(parts[0]) === norm(origin)) parts = parts.slice(1);
  if (parts.length && norm(parts[parts.length - 1]) === norm(dest)) {
    parts = parts.slice(0, -1);
  }
  return parts.join(" - ");
}

/**
 * Apply station name replacements to every viewMap row.
 * @param {Object|Array} routeData
 * @returns {Object|Array}
 */
export function applyReplacementsToRouteData(routeData) {
  if (!routeData || typeof routeData !== "object") return routeData;
  if (Array.isArray(routeData)) return routeData.map(applyStationNameReplacements);
  const processedData = {};
  for (const key of Object.keys(routeData)) {
    processedData[key] = applyStationNameReplacements(routeData[key]);
  }
  return processedData;
}

/**
 * Apply the same replacements to trips (booking + detail-panel endpoints).
 * Agency comes from the trip, falling back to its viewMap row.
 *
 * @param {Object} trips
 * @param {Object} [viewMap]
 * @returns {Object}
 */
export function applyReplacementsToTrips(trips, viewMap) {
  if (!trips || typeof trips !== "object") return trips;
  const out = {};
  for (const [key, trip] of Object.entries(trips)) {
    if (!trip || typeof trip !== "object") {
      out[key] = trip;
      continue;
    }
    const route =
      viewMap?.[trip.route_id] ?? viewMap?.[String(trip.route_id)] ?? null;
    const ctx = {
      routeId: trip.route_id ?? route?.route_id ?? null,
      agencyId: trip.agency_id ?? route?.agency_id ?? null,
    };
    const trip_origin = replaceStationField(trip.trip_origin, ctx);
    const trip_headsign = replaceStationField(trip.trip_headsign, ctx);
    out[key] = {
      ...trip,
      trip_origin,
      trip_headsign,
      via: dropViaEndpoints(replaceStationField(trip.via, ctx), trip_origin, trip_headsign),
    };
  }
  return out;
}
