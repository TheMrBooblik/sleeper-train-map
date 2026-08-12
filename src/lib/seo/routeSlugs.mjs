/**
 * Route endpoints + the retired /trains/[slug] slug map.
 *
 * The per-train pages are gone (they 301 into their /connections/ parent), but
 * their slugs are still needed to generate the redirect sources — those URLs are
 * indexed and must keep resolving. Shared as .mjs between the Next build
 * (src/lib/seo/data.js) and the raw-node generator
 * (scripts/build-seo-redirects.mjs) so both compute byte-identical slugs; if they
 * drifted, the redirect map would point at URLs the build never emits.
 */

import { slugify, buildTrainSlug } from "./slugify.mjs";

/**
 * A route's endpoints. Direction 0 is primary; direction 1 is the reverse leg,
 * used when a route only publishes the return.
 * @param {object} route - a viewMap row
 */
export function routeEndpoints(route) {
  return {
    origin: route.origin_trip_0 || route.origin_trip_1 || "",
    destination: route.destination_trip_0 || route.destination_trip_1 || "",
    trainNumber: route.trip_short_name_0 || route.trip_short_name_1 || "",
  };
}

/**
 * { byRouteId, bySlug } for the legacy per-train slugs, with deterministic
 * collision handling (a clashing slug gets "-2", "-3", …). Keys are iterated in
 * sorted order so the suffix assignment is stable across rebuilds.
 * @param {Record<string, object>} viewMap
 * @returns {{ byRouteId: Map<string,string>, bySlug: Map<string,string> }}
 */
export function buildRouteSlugMaps(viewMap) {
  const byRouteId = new Map();
  const bySlug = new Map();
  const used = new Set();
  for (const key of Object.keys(viewMap).sort()) {
    const route = viewMap[key];
    const routeId = String(route.route_id);
    if (byRouteId.has(routeId)) continue;
    const { origin, destination, trainNumber } = routeEndpoints(route);
    let slug =
      buildTrainSlug({ origin, destination, trainNumber }) || `route-${slugify(routeId)}`;
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    used.add(slug);
    byRouteId.set(routeId, slug);
    bySlug.set(slug, routeId);
  }
  return { byRouteId, bySlug };
}
