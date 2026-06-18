/**
 * Aggregations over the route summaries that power the hub pages:
 * country hubs, operator hubs and city-pair connection pages.
 *
 * All maps are memoized at module scope (one build = one computation).
 */

import { getAllRouteSummaries } from "./data";
import { getSeoCountry } from "./countries";
import { getOperatorMeta } from "./operators";
import { buildPairSlug } from "./slugify";

// Minimum distinct trains a directed city pair needs before it earns its own page.
// Single-train pairs are already covered by the train page (avoids thin/duplicate content).
const MIN_TRAINS_PER_PAIR = 2;

let _countryMap;
let _operatorMap;
let _operatorSlugToId;
let _pairMap;

function dedupePush(arr, summary) {
  if (!arr.some((r) => r.routeId === summary.routeId)) arr.push(summary);
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
      for (const opId of s.operatorIds) {
        if (!_operatorMap.has(opId)) {
          const operator = getOperatorMeta(opId);
          _operatorMap.set(opId, { operator, routes: [] });
          _operatorSlugToId.set(operator.slug, opId);
        }
        dedupePush(_operatorMap.get(opId).routes, s);
      }
    }
  }
  return _operatorMap;
}

/** pairSlug → { slug, originCity, destCity, routes[] } (all pairs, pre-threshold). */
function getPairMap() {
  if (!_pairMap) {
    _pairMap = new Map();
    for (const s of getAllRouteSummaries()) {
      for (const p of s.cityPairs) {
        if (!p.originCity || !p.destCity || p.originCity === p.destCity) continue;
        const slug = buildPairSlug(p.originCity, p.destCity);
        if (!slug) continue;
        if (!_pairMap.has(slug)) {
          _pairMap.set(slug, {
            slug,
            originCity: p.originCity,
            destCity: p.destCity,
            routes: [],
          });
        }
        dedupePush(_pairMap.get(slug).routes, s);
      }
    }
  }
  return _pairMap;
}

// --- Country hubs -----------------------------------------------------------

/** [{ country, routeCount }] sorted by name, for the index + sitemap. */
export function getAllCountryHubs() {
  return [...getCountryMap().values()]
    .map(({ country, routes }) => ({ country, routeCount: routes.length }))
    .sort((a, b) => a.country.name.localeCompare(b.country.name));
}

/** { country, routes[], operators[] } for a country slug, or null. */
export function getCountryHub(slug) {
  for (const { country, routes } of getCountryMap().values()) {
    if (country.slug === slug) {
      const operators = uniqueOperators(routes);
      return { country, routes: sortByTitle(routes), operators };
    }
  }
  return null;
}

// --- Operator hubs ----------------------------------------------------------

/** [{ operator, routeCount }] sorted by name. */
export function getAllOperatorHubs() {
  getOperatorMap();
  return [...getOperatorMap().values()]
    .map(({ operator, routes }) => ({ operator, routeCount: routes.length }))
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

/** [{ slug, originCity, destCity, routeCount }] for pairs that clear the threshold. */
export function getAllCityPairs() {
  return [...getPairMap().values()]
    .filter((p) => p.routes.length >= MIN_TRAINS_PER_PAIR)
    .map((p) => ({
      slug: p.slug,
      originCity: p.originCity,
      destCity: p.destCity,
      routeCount: p.routes.length,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** { originCity, destCity, routes[], operators[], countries[] } for a pair slug, or null. */
export function getCityPair(slug) {
  const pair = getPairMap().get(slug);
  if (!pair || pair.routes.length < MIN_TRAINS_PER_PAIR) return null;
  return {
    slug: pair.slug,
    originCity: pair.originCity,
    destCity: pair.destCity,
    routes: sortByTitle(pair.routes),
    operators: uniqueOperators(pair.routes),
    countries: uniqueCountries(pair.routes),
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

/** The city-pair slug for a route's primary direction, if such a hub exists. */
export function getCityPairSlugForRoute(summary) {
  const p = summary.cityPairs && summary.cityPairs[0];
  if (!p || !p.originCity || !p.destCity || p.originCity === p.destCity) return null;
  const slug = buildPairSlug(p.originCity, p.destCity);
  const pair = getPairMap().get(slug);
  return pair && pair.routes.length >= MIN_TRAINS_PER_PAIR ? slug : null;
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
