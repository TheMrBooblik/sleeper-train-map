/**
 * Aggregations over the route summaries that power the hub pages:
 * country hubs, operator hubs and city-pair connection pages.
 *
 * All maps are memoized at module scope (one build = one computation).
 */

import { getAllRouteSummaries, getStationCountryCode } from "./data";
import { getSeoCountry, getSeoCountryBySlug } from "./countries";
import { buildPairSlug, orderCityPair, slugify } from "./slugify.mjs";

// Every city pair earns a page. /connections/ is now the only route page type —
// /trains/[slug] was retired into it — so gating here would leave routes with no
// page at all. Thin content is no longer a risk either: a pair page carries the
// full timetable, stops and booking CTA for every train on the corridor.
const MIN_TRAINS_PER_PAIR = 1;

// Minimum routes a station needs before it earns its own "/from" page. A
// single-route station would just duplicate that train page, so we gate it.
const MIN_ROUTES_PER_STATION = 2;

let _countryMap;
let _operatorMap;
let _operatorSlugToId;
let _pairMap;
let _stationMap;

function dedupePush(arr, summary) {
  if (!arr.some((r) => r.routeId === summary.routeId)) arr.push(summary);
}

/**
 * The most recent "YYYY-MM-DD" any of these routes actually changed, or "".
 *
 * A hub page is as fresh as its freshest route, and plain string comparison is
 * correct for ISO dates. Routes with no history contribute nothing rather than
 * dragging the page's date to the epoch.
 */
function lastChangedOf(routes) {
  let latest = "";
  for (const r of routes) {
    if (r.lastChanged && r.lastChanged > latest) latest = r.lastChanged;
  }
  return latest;
}

/** code → { country, routes[] } for every hub country with ≥1 route. */
function getCountryMap() {
  if (!_countryMap) {
    _countryMap = new Map();
    for (const s of getAllRouteSummaries()) {
      for (const code of s.countries) {
        const country = getSeoCountry(code);
        if (!country) continue; // restrict to hub countries (24 + GB)
        if (!_countryMap.has(code)) _countryMap.set(code, { country, routes: [] });
        dedupePush(_countryMap.get(code).routes, s);
      }
    }
  }
  return _countryMap;
}

/** agency_id → { operator, routes[] } for every operator with ≥1 route. */
function getOperatorMap() {
  if (!_operatorMap) {
    _operatorMap = new Map();
    _operatorSlugToId = new Map();
    for (const s of getAllRouteSummaries()) {
      // Reuse operators already resolved on the summary (curated name + BoT
      // fallback) so hub pages never re-resolve without the agencies snapshot.
      for (const operator of s.operators || []) {
        const opId = operator.id;
        if (!_operatorMap.has(opId)) {
          _operatorMap.set(opId, { operator, routes: [] });
          _operatorSlugToId.set(operator.slug, opId);
        }
        dedupePush(_operatorMap.get(opId).routes, s);
      }
    }
  }
  return _operatorMap;
}

/**
 * pairSlug → { slug, cityA, cityB, countryCodes:Set, routes[] }.
 *
 * Pairs are UNDIRECTED: a night train that runs Paris→Vienna also runs
 * Vienna→Paris, so both directions collapse onto one page. Previously each
 * direction got its own near-identical page, self-canonical, doubling the crawl
 * surface for zero extra coverage. cityA/cityB are in canonical (slug) order so
 * the URL and the page heading always agree.
 */
function getPairMap() {
  if (!_pairMap) {
    _pairMap = new Map();
    for (const s of getAllRouteSummaries()) {
      for (const p of s.cityPairs) {
        if (!p.originCity || !p.destCity || p.originCity === p.destCity) continue;
        const slug = buildPairSlug(p.originCity, p.destCity);
        if (!slug) continue;
        const [cityA, cityB] = orderCityPair(p.originCity, p.destCity);
        if (!_pairMap.has(slug)) {
          _pairMap.set(slug, {
            slug,
            cityA,
            cityB,
            // Which countries this pair's endpoints sit in, so a country hub can
            // surface the connections that touch it.
            countryCodes: new Set(),
            routes: [],
          });
        }
        const entry = _pairMap.get(slug);
        if (p.originCountry) entry.countryCodes.add(p.originCountry);
        if (p.destCountry) entry.countryCodes.add(p.destCountry);
        dedupePush(entry.routes, s);
      }
    }
  }
  return _pairMap;
}

// --- Country hubs -----------------------------------------------------------

/** [{ country, routeCount }] sorted by name, for the index + sitemap. */
export function getAllCountryHubs() {
  return [...getCountryMap().values()]
    .map(({ country, routes }) => ({
      country,
      routeCount: routes.length,
      lastChanged: lastChangedOf(routes),
    }))
    .sort((a, b) => a.country.name.localeCompare(b.country.name));
}

/** { country, routes[], operators[], facts } for a country slug, or null. */
export function getCountryHub(slug) {
  for (const { country, routes } of getCountryMap().values()) {
    if (country.slug === slug) {
      const operators = uniqueOperators(routes);
      return {
        country,
        routes: sortByTitle(routes),
        operators,
        facts: countryFacts(routes, operators),
      };
    }
  }
  return null;
}

/**
 * Compact headline facts for a country hub: how many routes/operators, the
 * fastest and longest journeys, and the cheapest known "from" price. Every
 * field degrades gracefully (null) when the underlying data is missing.
 */
function countryFacts(routes, operators) {
  const timed = routes.filter((r) => r.durationMinutes > 0);
  const pick = (better) =>
    timed.length
      ? timed.reduce((best, r) => (better(r.durationMinutes, best.durationMinutes) ? r : best))
      : null;
  const brief = (r) =>
    r && { title: r.title, slug: r.slug, durationText: r.durationText };

  const fastest = pick((a, b) => a < b);
  const longest = pick((a, b) => a > b);

  let minFromPrice = null;
  for (const r of routes) {
    const p = r.pricing;
    if (p && p.fromPrice != null) {
      if (!minFromPrice || p.fromPrice < minFromPrice.fromPrice) {
        // currency defaults to null (never undefined) so the object stays
        // JSON-serializable for getStaticProps.
        minFromPrice = { fromPrice: p.fromPrice, currency: p.currency || null };
      }
    }
  }

  return {
    routeCount: routes.length,
    operatorCount: operators.length,
    fastest: brief(fastest),
    longest: brief(longest),
    minFromPrice,
  };
}

/**
 * Every city-pair connection whose endpoints touch this country. Country hubs
 * link to ALL of them (not a "popular" subset) — they are the main crawl path
 * into the long tail of connection pages.
 * Sorted by how many trains serve the pair, then alphabetically.
 */
export function getConnectionsForCountry(countrySlug) {
  const country = getSeoCountryBySlug(countrySlug);
  if (!country) return [];
  return [...getPairMap().values()]
    .filter(
      (p) => p.routes.length >= MIN_TRAINS_PER_PAIR && p.countryCodes.has(country.code),
    )
    .map((p) => ({
      slug: p.slug,
      cityA: p.cityA,
      cityB: p.cityB,
      routeCount: p.routes.length,
    }))
    .sort((a, b) => b.routeCount - a.routeCount || a.slug.localeCompare(b.slug));
}

/** Every connection served by an operator — closes the operator→connection link gap. */
export function getConnectionsForOperator(operatorSlug) {
  getOperatorMap();
  const opId = _operatorSlugToId.get(operatorSlug);
  if (!opId) return [];
  return [...getPairMap().values()]
    .filter(
      (p) =>
        p.routes.length >= MIN_TRAINS_PER_PAIR &&
        p.routes.some((r) => r.operatorIds.includes(opId)),
    )
    .map((p) => ({
      slug: p.slug,
      cityA: p.cityA,
      cityB: p.cityB,
      routeCount: p.routes.length,
    }))
    .sort((a, b) => b.routeCount - a.routeCount || a.slug.localeCompare(b.slug));
}

/** Every connection touching a city — closes the station-hub→connection link gap. */
export function getConnectionsForCity(cityName) {
  if (!cityName) return [];
  return [...getPairMap().values()]
    .filter(
      (p) =>
        p.routes.length >= MIN_TRAINS_PER_PAIR &&
        (p.cityA === cityName || p.cityB === cityName),
    )
    .map((p) => ({
      slug: p.slug,
      cityA: p.cityA,
      cityB: p.cityB,
      routeCount: p.routes.length,
    }))
    .sort((a, b) => b.routeCount - a.routeCount || a.slug.localeCompare(b.slug));
}

/**
 * Other country hubs reachable from this one — the union of countries served by
 * this country's routes, minus itself. Because each connected country shares a
 * route with this one, it always has its own hub page. Powers the "travel
 * onward" cross-links (and closes the current country↔country linking gap).
 */
export function getConnectedCountries(countrySlug) {
  const self = getSeoCountryBySlug(countrySlug);
  const hub = getCountryHub(countrySlug);
  if (!self || !hub) return [];
  return uniqueCountries(hub.routes).filter((c) => c.code !== self.code);
}

// --- Operator hubs ----------------------------------------------------------

/** [{ operator, routeCount }] sorted by name. */
export function getAllOperatorHubs() {
  getOperatorMap();
  return [...getOperatorMap().values()]
    .map(({ operator, routes }) => ({
      operator,
      routeCount: routes.length,
      lastChanged: lastChangedOf(routes),
    }))
    .sort((a, b) => a.operator.name.localeCompare(b.operator.name));
}

/** { operator, routes[], countries[] } for an operator slug, or null. */
export function getOperatorHub(slug) {
  getOperatorMap();
  const opId = _operatorSlugToId.get(slug);
  if (!opId) return null;
  const { operator, routes } = getOperatorMap().get(opId);
  return { operator, routes: sortByTitle(routes), countries: uniqueCountries(routes) };
}

// --- City-pair connections --------------------------------------------------

/** [{ slug, cityA, cityB, routeCount }] for every city pair, alphabetical. */
export function getAllCityPairs() {
  return [...getPairMap().values()]
    .filter((p) => p.routes.length >= MIN_TRAINS_PER_PAIR)
    .map((p) => ({
      slug: p.slug,
      cityA: p.cityA,
      cityB: p.cityB,
      routeCount: p.routes.length,
      lastChanged: lastChangedOf(p.routes),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** [{ slug, cityA, cityB, routeCount }] sorted by how many trains serve the pair. */
export function getTopCityPairs(limit = 50) {
  return getAllCityPairs()
    .sort((a, b) => b.routeCount - a.routeCount || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** { cityA, cityB, routes[], operators[], countries[] } for a pair slug, or null. */
export function getCityPair(slug) {
  const pair = getPairMap().get(slug);
  if (!pair || pair.routes.length < MIN_TRAINS_PER_PAIR) return null;
  return {
    slug: pair.slug,
    cityA: pair.cityA,
    cityB: pair.cityB,
    routes: sortByTitle(pair.routes),
    operators: uniqueOperators(pair.routes),
    countries: uniqueCountries(pair.routes),
  };
}

/**
 * Related connections for a pair page, best-first: pairs sharing an endpoint city,
 * then pairs served by the same operator, then pairs in the same country. Under
 * crawl starvation these links are what get the long tail discovered at all — the
 * sitemap alone is the weakest possible signal.
 * @param {string} slug - the pair to find neighbours for
 * @param {number} limit
 */
export function getRelatedConnections(slug, limit = 8) {
  const pair = getPairMap().get(slug);
  if (!pair) return [];

  const opIds = new Set();
  for (const r of pair.routes) for (const id of r.operatorIds) opIds.add(id);

  const scored = [];
  for (const other of getPairMap().values()) {
    if (other.slug === slug || other.routes.length < MIN_TRAINS_PER_PAIR) continue;
    const sharesEndpoint =
      other.cityA === pair.cityA ||
      other.cityA === pair.cityB ||
      other.cityB === pair.cityA ||
      other.cityB === pair.cityB;
    const sharesOperator = other.routes.some((r) =>
      r.operatorIds.some((id) => opIds.has(id)),
    );
    const sharesCountry = [...other.countryCodes].some((c) => pair.countryCodes.has(c));
    if (!sharesEndpoint && !sharesOperator && !sharesCountry) continue;
    const rank = sharesEndpoint ? 0 : sharesOperator ? 1 : 2;
    scored.push({ rank, other });
  }

  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.other.routes.length - a.other.routes.length ||
        a.other.slug.localeCompare(b.other.slug),
    )
    .slice(0, limit)
    .map(({ other }) => ({
      slug: other.slug,
      cityA: other.cityA,
      cityB: other.cityB,
      routeCount: other.routes.length,
    }));
}

// --- Station hubs (nested under country: /night-trains/{country}/from/{station}) ---

/**
 * countryCode → (stationSlug → { name, slug, countryCode, routes[] }).
 *
 * A route's two physical endpoints (origin + destination) each become a "from"
 * station — night trains run both directions, so "from A" and "from B" are both
 * valid. Each station is nested under the country it physically sits in, derived
 * from the raw Back-on-Track stop→country index (not the route's country list,
 * which can span several countries).
 */
function getStationMap() {
  if (!_stationMap) {
    _stationMap = new Map();
    for (const s of getAllRouteSummaries()) {
      const endpoints = [
        { raw: s.origin, city: s.originCity },
        { raw: s.destination, city: s.destinationCity },
      ];
      for (const { raw, city } of endpoints) {
        if (!city) continue;
        const code = getStationCountryCode(raw);
        if (!getSeoCountry(code)) continue; // only nest under real hub countries
        const slug = slugify(city);
        if (!slug) continue;
        if (!_stationMap.has(code)) _stationMap.set(code, new Map());
        const byStation = _stationMap.get(code);
        if (!byStation.has(slug)) {
          byStation.set(slug, { name: city, slug, countryCode: code, routes: [] });
        }
        dedupePush(byStation.get(slug).routes, s);
      }
    }
  }
  return _stationMap;
}

/** [{ name, slug, routeCount }] for a country slug — only stations clearing the threshold. */
export function getStationHubsForCountry(countrySlug) {
  const country = getSeoCountryBySlug(countrySlug);
  if (!country) return [];
  const byStation = getStationMap().get(country.code);
  if (!byStation) return [];
  return [...byStation.values()]
    .filter((st) => st.routes.length >= MIN_ROUTES_PER_STATION)
    .map((st) => ({
      name: st.name,
      slug: st.slug,
      routeCount: st.routes.length,
      lastChanged: lastChangedOf(st.routes),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** { country, station:{name,slug}, routes[], operators[] } for a country+station slug, or null. */
export function getStationHub(countrySlug, stationSlug) {
  const country = getSeoCountryBySlug(countrySlug);
  if (!country) return null;
  const byStation = getStationMap().get(country.code);
  const station = byStation && byStation.get(stationSlug);
  if (!station || station.routes.length < MIN_ROUTES_PER_STATION) return null;
  return {
    country,
    station: { name: station.name, slug: station.slug },
    routes: sortByTitle(station.routes),
    operators: uniqueOperators(station.routes),
  };
}

// --- Cross-link helpers -----------------------------------------------------

/** Other routes by the same operator(s), excluding the given route. */
export function getRelatedRoutes(summary, limit = 6) {
  getOperatorMap();
  const seen = new Set([summary.routeId]);
  const related = [];
  for (const opId of summary.operatorIds) {
    const bucket = getOperatorMap().get(opId);
    if (!bucket) continue;
    for (const r of bucket.routes) {
      if (seen.has(r.routeId)) continue;
      seen.add(r.routeId);
      related.push(r);
      if (related.length >= limit) return related;
    }
  }
  return related;
}

/**
 * The connection page a route belongs to. Every route has one now (the pair map
 * is built from the same summaries and no longer gates on train count), which is
 * what makes retiring /trains/[slug] into a 301 safe — see
 * scripts/build-seo-redirects.mjs, which resolves the redirect targets through
 * exactly this function.
 * @returns {string|null} pair slug, or null for a route with no usable endpoints
 */
export function getCityPairSlugForRoute(summary) {
  for (const p of summary.cityPairs || []) {
    if (!p.originCity || !p.destCity || p.originCity === p.destCity) continue;
    const slug = buildPairSlug(p.originCity, p.destCity);
    if (getPairMap().has(slug)) return slug;
  }
  return null;
}

// --- internal ---------------------------------------------------------------

function sortByTitle(routes) {
  return [...routes].sort((a, b) => a.title.localeCompare(b.title));
}

function uniqueOperators(routes) {
  const byId = new Map();
  for (const r of routes) {
    for (const op of r.operators) if (!byId.has(op.id)) byId.set(op.id, op);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueCountries(routes) {
  const byCode = new Map();
  for (const r of routes) {
    for (const code of r.countries) {
      const country = getSeoCountry(code);
      if (country && !byCode.has(code)) byCode.set(code, country);
    }
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
}
