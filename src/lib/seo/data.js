/**
 * Build-time data layer for the SEO pages.
 *
 * Reads the committed, review-gated payload (public/data/published/initial-data.json)
 * and the raw Back-on-Track stops (for station→country derivation) from disk. Every
 * read is lazy + memoized at module scope so a full build parses each file once and
 * each page does O(1) lookups.
 *
 * IMPORTANT: this module uses `fs` and must only ever be imported from
 * getStaticProps / getStaticPaths (server/build only). Next strips it from the client
 * bundle, so the 4 MB payload never ships to the browser.
 */

import fs from "fs";
import path from "path";

import { parseBotServiceString, renderCalendar } from "../../pages/api/lib/calendar.mjs";
import { normalizeStationNameForDisplay } from "../../components/Map/utils/stationNameUtils";
// Reuse the exact "not yet running" detection the map hover uses, so a route is
// flagged "future" here in the same way (irregularities "From …", postponed
// notes, or an upcoming service_id season).
import { getFutureRouteStartDate } from "../../components/Map/utils/routeStyleUtils";
import { getRouteFrequencyOverride } from "../routeFrequencyOverrides";
import { slugify, buildTrainSlug } from "./slugify";
import { getStationTimesForTrain } from "./stationTimes";
import {
  deriveTitle,
  formatAnyTime,
  parseViaList,
  formatDuration,
  durationToMinutes,
  formatDistanceKm,
  formatCo2,
  formatFutureFrom,
} from "./format";
import { getOperatorPricing, formatFromPrice } from "../operatorPricing";
import { splitAgencyIds, getOperatorMeta } from "./operators";
import {
  normalizeCountryCode,
  getSeoCountry,
  OPERATOR_COUNTRY_FALLBACK,
} from "./countries";

const PUBLISHED_PATH = "public/data/published/initial-data.json";
const RAW_STOPS_PATH = "public/data/scraped/backontrack-stops.json";

let _publishedFull;
let _stopCoords;
let _stopCountry;
let _tripsByRoute;
let _slugMaps;
let _summaries;

function readJson(relPath) {
  const abs = path.join(process.cwd(), relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

/** The full published file (memoized). */
function getPublishedFull() {
  if (!_publishedFull) _publishedFull = readJson(PUBLISHED_PATH);
  return _publishedFull;
}

/** The published { stops, viewMap, trips } payload. */
function getPublished() {
  return getPublishedFull().data;
}

/** ISO timestamp of the data's last generation (for sitemap lastmod). */
export function getDataGeneratedAt() {
  const j = getPublishedFull();
  return j.generatedAt || j.uploadedAt || new Date().toISOString();
}

/** name → [lat, lon] from the published stops (for map fallback geometry). */
function getStopCoords() {
  if (!_stopCoords) {
    _stopCoords = new Map();
    for (const s of getPublished().stops) {
      if (s && s.stop_name && Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon)) {
        if (!_stopCoords.has(s.stop_name)) {
          _stopCoords.set(s.stop_name, [s.stop_lat, s.stop_lon]);
        }
      }
    }
  }
  return _stopCoords;
}

/** lowercased name / id → ISO2 country, from raw Back-on-Track stops (memoized). */
function getStopCountryIndex() {
  if (!_stopCountry) {
    _stopCountry = new Map();
    let raw;
    try {
      raw = readJson(RAW_STOPS_PATH).data;
    } catch {
      raw = null;
    }
    if (raw) {
      const rows = Array.isArray(raw) ? raw : Object.values(raw);
      for (const s of rows) {
        const code = normalizeCountryCode(s && s.stop_country);
        if (!code) continue;
        if (s.stop_name) _stopCountry.set(String(s.stop_name).toLowerCase(), code);
        if (s.stop_id) _stopCountry.set(String(s.stop_id).toLowerCase(), code);
      }
    }
  }
  return _stopCountry;
}

/**
 * Normalized ISO-2 country code for a station name, derived from the raw
 * Back-on-Track stop index. Returns "" when the station is unknown.
 * Used by the per-station hub aggregator to nest stations under their country.
 * @param {string} name - raw station name (e.g. route.origin_trip_0)
 * @returns {string}
 */
export function getStationCountryCode(name) {
  if (!name) return "";
  return getStopCountryIndex().get(String(name).toLowerCase()) || "";
}

/** routeId(string) → trips[] (memoized). */
function getTripsByRoute() {
  if (!_tripsByRoute) {
    _tripsByRoute = new Map();
    for (const trip of Object.values(getPublished().trips)) {
      const id = String(trip.route_id);
      if (!_tripsByRoute.has(id)) _tripsByRoute.set(id, []);
      _tripsByRoute.get(id).push(trip);
    }
  }
  return _tripsByRoute;
}

function routeEndpoints(route) {
  return {
    origin: route.origin_trip_0 || route.origin_trip_1 || "",
    destination: route.destination_trip_0 || route.destination_trip_1 || "",
    trainNumber: route.trip_short_name_0 || route.trip_short_name_1 || "",
  };
}

/** { byRouteId: Map, bySlug: Map } with deterministic collision handling. */
function getSlugMaps() {
  if (!_slugMaps) {
    const { viewMap } = getPublished();
    const byRouteId = new Map();
    const bySlug = new Map();
    const used = new Set();
    for (const key of Object.keys(viewMap).sort()) {
      const route = viewMap[key];
      const routeId = String(route.route_id);
      if (byRouteId.has(routeId)) continue;
      const { origin, destination, trainNumber } = routeEndpoints(route);
      let slug =
        buildTrainSlug({ origin, destination, trainNumber }) ||
        `route-${slugify(routeId)}`;
      if (used.has(slug)) {
        let n = 2;
        while (used.has(`${slug}-${n}`)) n += 1;
        slug = `${slug}-${n}`;
      }
      used.add(slug);
      byRouteId.set(routeId, slug);
      bySlug.set(slug, routeId);
    }
    _slugMaps = { byRouteId, bySlug };
  }
  return _slugMaps;
}

/** Render a human-readable "days of operation" string for a direction. */
function serviceDaysFor(route, dir, trip) {
  const raw = route[`service_id_${dir}`] || (trip && trip.service_id) || "";
  if (raw) {
    try {
      const rendered = renderCalendar(parseBotServiceString(raw));
      if (rendered) return rendered;
    } catch {
      /* fall through to raw */
    }
    return raw;
  }
  const override = getRouteFrequencyOverride(String(route.route_id));
  return override || "";
}

/** Country codes for a route: trips.countries, else station-derived, else operator fallback. */
function countryCodesForRoute(route, allStopNames, operatorIds) {
  const codes = new Set();
  const trips = getTripsByRoute().get(String(route.route_id)) || [];
  for (const trip of trips) {
    for (const tok of String(trip.countries || "").split(/[,/]/)) {
      const code = normalizeCountryCode(tok);
      if (code) codes.add(code);
    }
  }
  if (codes.size === 0) {
    const idx = getStopCountryIndex();
    for (const name of allStopNames) {
      const code = idx.get(String(name).toLowerCase());
      if (code) codes.add(code);
    }
    if (codes.size === 0) {
      for (const opId of operatorIds) {
        for (const code of OPERATOR_COUNTRY_FALLBACK[opId] || []) {
          codes.add(normalizeCountryCode(code));
        }
      }
    }
  }
  return [...codes];
}

/** Build the lightweight summary for one viewMap route. */
function buildSummary(route) {
  const routeId = String(route.route_id);
  const slug = getSlugMaps().byRouteId.get(routeId);
  const { origin, destination, trainNumber } = routeEndpoints(route);
  const operatorIds = splitAgencyIds(route.agency_id);
  const trainNumbers = [route.trip_short_name_0, route.trip_short_name_1]
    .map((t) => (t || "").trim())
    .filter(Boolean);

  const stopNames = new Set();
  const cityPairs = [];
  for (const dir of [0, 1]) {
    const o = route[`origin_trip_${dir}`];
    const d = route[`destination_trip_${dir}`];
    if (o) stopNames.add(o);
    if (d) stopNames.add(d);
    for (const v of parseViaList(route[`via_${dir}`])) stopNames.add(v);
    if (o && d) {
      cityPairs.push({
        originCity: normalizeStationNameForDisplay(o),
        destCity: normalizeStationNameForDisplay(d),
        // Physical country of each endpoint, so we can filter city-pair
        // connections down to those touching a given country hub.
        originCountry: getStationCountryCode(o),
        destCountry: getStationCountryCode(d),
      });
    }
  }
  const countries = countryCodesForRoute(route, stopNames, operatorIds);

  // Journey length + price come from the direction-0 trip (same source the full
  // detail view uses). Kept on the summary so hub pages can show a duration/price
  // badge and compute "fastest/longest/from" facts without a second data pass.
  const trips = getTripsByRoute().get(routeId) || [];
  const factTrip = trips.find((t) => Number(t.direction_id) === 0) || trips[0] || null;
  const durationMinutes = factTrip ? durationToMinutes(factTrip.duration) : 0;
  const pricing = getOperatorPricing({
    agency_id: route.agency_id,
    pricing: route.pricing,
  });

  // Card display: always show the "Origin – Destination" city title, and expose
  // the operator's proper train NAME (e.g. "Bessarabia", "Le Train Bleu")
  // separately so cards can show it in small type. A long_name that is itself a
  // "City – City" description (contains a spaced dash) is not a real name.
  const endpointTitle =
    origin && destination ? `${origin} – ${destination}` : origin || destination || "Night train";
  const longName = (route.route_long_name || "").trim();
  const routeName =
    longName && !/\s[–-]\s/.test(longName) && longName !== endpointTitle ? longName : "";

  // Future ("not yet running") flag — reuses the map's detector verbatim.
  const futureStartDate = getFutureRouteStartDate(routeId, getPublished().trips);

  return {
    routeId,
    slug,
    title: deriveTitle(route, origin, destination),
    endpointTitle,
    routeName,
    origin,
    destination,
    originCity: normalizeStationNameForDisplay(origin),
    destinationCity: normalizeStationNameForDisplay(destination),
    trainNumber,
    trainNumbers,
    agencyId: route.agency_id || "",
    operators: operatorIds.map(getOperatorMeta),
    operatorIds,
    countries,
    cityPairs,
    durationMinutes,
    durationText: factTrip ? formatDuration(factTrip.duration) : "",
    pricing,
    fromPrice: formatFromPrice(pricing),
    futureStartDate,
    futureFrom: formatFutureFrom(futureStartDate),
    hasPolyline: Boolean(route.nj_polyline_0 || route.nj_polyline_1),
  };
}

/**
 * Trim a route summary to the lean shape the hub-page route cards need. Used by
 * every page that renders <RouteCardLink> so the card treatment (city title +
 * small train name + duration/price/future badge) stays consistent everywhere.
 * @param {object} s - a summary from getAllRouteSummaries()
 */
export function toCardRoute(s) {
  return {
    routeId: s.routeId,
    slug: s.slug,
    title: s.endpointTitle || s.title, // city "A – B" title on the card
    routeName: s.routeName || "",
    trainNumbers: s.trainNumbers,
    operatorIds: s.operatorIds,
    operators: s.operators,
    durationText: s.durationText || "",
    fromPrice: s.fromPrice || null,
    futureFrom: s.futureFrom || "",
  };
}

/** All route summaries (memoized), sorted by title for stable hub ordering. */
export function getAllRouteSummaries() {
  if (!_summaries) {
    const { viewMap } = getPublished();
    _summaries = Object.values(viewMap)
      .map(buildSummary)
      .sort((a, b) => a.title.localeCompare(b.title));
  }
  return _summaries;
}

/** { bySlug, byRouteId } slug maps for getStaticPaths / getStaticProps. */
export function getRouteSlugMap() {
  return getSlugMaps();
}

/**
 * Full per-train view model for /trains/[slug]. Returns null for unknown ids.
 * @param {string} routeId
 */
export function getRouteDetail(routeId) {
  const { viewMap } = getPublished();
  const route = Object.values(viewMap).find((r) => String(r.route_id) === String(routeId));
  if (!route) return null;

  const summary = buildSummary(route);
  const trips = getTripsByRoute().get(String(routeId)) || [];
  const coords = getStopCoords();

  const directions = [];
  for (const dir of [0, 1]) {
    const trainNumber = (route[`trip_short_name_${dir}`] || "").trim();
    if (!trainNumber) continue;
    const origin = route[`origin_trip_${dir}`] || "";
    const destination = route[`destination_trip_${dir}`] || "";
    const via = parseViaList(route[`via_${dir}`]);
    const trip = trips.find((t) => Number(t.direction_id) === dir) || trips[dir] || null;

    const vmDeparture = formatAnyTime(route[`origin_departure_time_${dir}`]);
    const vmArrival = formatAnyTime(route[`destination_arrival_time_${dir}`]);

    // Prefer the operator's own station sequence (full stop list + per-stop times +
    // coordinates); fall back to the published "via" names with endpoint times only.
    const raw = getStationTimesForTrain(trainNumber, { origin, destination });
    let stops;
    if (raw) {
      stops = raw.map((s) => ({
        name: s.name,
        lat: Number.isFinite(s.lat) ? s.lat : null,
        lon: Number.isFinite(s.lon) ? s.lon : null,
        departure: formatAnyTime(s.departure),
        arrival: formatAnyTime(s.arrival),
      }));
      // Endpoint times prefer the gated viewMap value over the live feed.
      if (vmDeparture) stops[0].departure = vmDeparture;
      if (vmArrival) stops[stops.length - 1].arrival = vmArrival;
    } else {
      const names = [origin, ...via, destination].filter(Boolean);
      stops = names.map((name, i) => {
        const c = coords.get(name);
        return {
          name,
          lat: c ? c[0] : null,
          lon: c ? c[1] : null,
          departure: i === 0 ? vmDeparture : "",
          arrival: i === names.length - 1 ? vmArrival : "",
        };
      });
    }

    directions.push({
      trainNumber,
      origin,
      destination,
      departureTime: vmDeparture || stops[0]?.departure || "",
      arrivalTime: vmArrival || stops[stops.length - 1]?.arrival || "",
      via,
      stops,
      serviceDays: serviceDaysFor(route, dir, trip),
      irregularities: (route[`irregularities_${dir}`] || "").trim(),
    });
  }

  // Facts come from the direction-0 trip when present.
  const factTrip = trips.find((t) => Number(t.direction_id) === 0) || trips[0] || null;
  const facts = {
    durationText: factTrip ? formatDuration(factTrip.duration) : "",
    distanceText: factTrip ? formatDistanceKm(factTrip.distance) : "",
    co2Text: factTrip ? formatCo2(factTrip.emissions_co2e) : "",
    classes: (factTrip && factTrip.classes ? String(factTrip.classes) : "").trim(),
  };

  // Map geometry: encoded polylines (preferred) + station markers from the
  // primary direction's resolved stops (operator coords, else name lookup).
  const primary = directions[0] || {};
  const mapStops = (primary.stops || [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ name: s.name, lat: s.lat, lon: s.lon }));

  return {
    routeId: String(routeId),
    slug: summary.slug,
    title: summary.title,
    origin: summary.origin,
    destination: summary.destination,
    originCity: summary.originCity,
    destinationCity: summary.destinationCity,
    primaryTrainNumber: summary.trainNumber,
    longName: (route.route_long_name || "").trim(),
    agencyId: route.agency_id || "",
    operators: summary.operators,
    pricing: route.pricing || null,
    countryCodes: summary.countries,
    countries: summary.countries.map(getSeoCountry).filter(Boolean),
    directions,
    facts,
    map: {
      polyline0: route.nj_polyline_0 || null,
      polyline1: route.nj_polyline_1 || null,
      stops: mapStops,
    },
  };
}
