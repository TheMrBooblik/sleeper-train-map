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
// Reuse the exact "not yet running" detection the map hover uses, so a route is
// flagged "future" here in the same way (irregularities "From …", postponed
// notes, or an upcoming service_id season).
import { getFutureRouteStartDate } from "../../components/Map/utils/routeStyleUtils";
import { getRouteFrequencyOverride } from "../routeFrequencyOverrides";
import { buildPairSlug } from "./slugify.mjs";
import { routeEndpoints, buildRouteSlugMaps } from "./routeSlugs.mjs";
import { cityForStation } from "./cities.mjs";
import { getStationTimesForTrain } from "./stationTimes.mjs";
import {
  deriveTitle,
  formatAnyTime,
  parseViaList,
  routeDurationMinutes,
  formatDurationMinutes,
  formatDistanceKm,
  formatCo2,
  formatFutureFrom,
} from "./format";
import { getOperatorPricing, formatFromPrice } from "../operatorPricing";
import {
  formatTrainNumber,
  resolveScheduleLink,
} from "../operatorAgencies.mjs";
import { resolveRouteBooking } from "../routeBooking.mjs";
import { splitAgencyIds, getOperatorMeta } from "./operators";
import {
  normalizeCountryCode,
  getSeoCountry,
  OPERATOR_COUNTRY_FALLBACK,
} from "./countries";
import {
  applyReplacementsToRouteData,
  applyReplacementsToTrips,
} from "../../data/stationNameReplacements";
// The map withholds admin-disabled routes per request (see /api/initial-data);
// the static pages read the published artifact directly and so used to keep
// serving them. That left Back-on-Track's retired European Sleeper 456/457
// (Brussels-Milan via Zürich) with a live connection page after the operator's
// own feed replaced it with ES 400/401 via Aarau.
import { stripDisabledRoutes } from "../../pages/api/lib/build-initial-data.mjs";
import DISABLED_ROUTES from "../../../data/overrides/disabled-routes.json";

const PUBLISHED_PATH = "public/data/published/initial-data.json";
const RAW_STOPS_PATH = "public/data/scraped/backontrack-stops.json";
const AGENCIES_PATH = "public/data/scraped/backontrack-agencies.json";
// Per-route { firstSeen, lastSeen, lastChanged }, projected from seen.json by
// canonicalize. Optional: a build without it degrades to the payload's own
// generation date, which is what every URL used to claim anyway.
const ROUTE_HISTORY_PATH = "public/data/published/route-history.json";

let _publishedFull;
let _publishedNormalized;
let _stopCoords;
let _stopCountry;
let _agencies;
let _tripsByRoute;
let _slugMaps;
let _summaries;
let _routeHistory;

function readJson(relPath) {
  const abs = path.join(process.cwd(), relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

/** The full published file (memoized). */
function getPublishedFull() {
  if (!_publishedFull) _publishedFull = readJson(PUBLISHED_PATH);
  return _publishedFull;
}

/** The published { stops, viewMap, trips } payload, as the map serves it. */
function getPublished() {
  if (!_publishedNormalized) {
    // Disabled routes come off first, so nothing downstream — summaries, hubs,
    // city pairs, the sitemap — can build a page for a route the map hides.
    const data = stripDisabledRoutes(getPublishedFull().data, DISABLED_ROUTES);
    // Same terminus rewrites the live map applies (e.g. Leo Express Frankfurt
    // Flughafen → Süd). Done here so SEO pages match without re-canonicalizing.
    const viewMap = applyReplacementsToRouteData(data.viewMap);
    _publishedNormalized = {
      ...data,
      viewMap,
      trips: applyReplacementsToTrips(data.trips, viewMap),
    };
  }
  return _publishedNormalized;
}

/**
 * routeId → "YYYY-MM-DD" of the last real change to that route (any fingerprint
 * difference, stop-sequence drift included), memoized.
 *
 * The sitemap used to stamp the payload's generation date on all 241 URLs, so
 * every nightly scrape told crawlers the whole site had changed — which spends a
 * rationed crawl budget re-reading 162 routes that have not moved since June.
 * Missing file, or a route missing from it, yields "" and the caller falls back.
 */
function getRouteHistory() {
  if (!_routeHistory) {
    try {
      _routeHistory = readJson(ROUTE_HISTORY_PATH)?.routes ?? {};
    } catch (err) {
      // Degrading to the payload's own date is deliberate — the sitemap must
      // never 500 over a missing optional artifact — but it degrades to exactly
      // the flat lastmod this replaced, which is invisible from the output. Say
      // so once, so a lambda that cannot reach the file shows up in the logs
      // instead of quietly undoing the change.
      console.warn(`[seo] ${ROUTE_HISTORY_PATH} unreadable, lastmod falls back to the payload date: ${err.message}`);
      _routeHistory = {};
    }
  }
  return _routeHistory;
}

/** ISO timestamp of the data's last generation (for sitemap lastmod). */
export function getDataGeneratedAt() {
  const j = getPublishedFull();
  return j.generatedAt || j.uploadedAt || new Date().toISOString();
}

/**
 * "Is this a station?" over the published stops, for splitting a via string by
 * station name rather than by the " - " separator that 437 of those names
 * contain. Both spellings are indexed because 703 records give stop_id and
 * stop_name different values.
 */
let _knownStation = null;
function getKnownStation() {
  if (!_knownStation) {
    const keys = new Set();
    for (const s of getPublished().stops) {
      for (const n of [s?.stop_id, s?.stop_name]) {
        if (n) keys.add(String(n).trim().toLowerCase());
      }
    }
    _knownStation = (name) => keys.has(String(name ?? "").trim().toLowerCase());
  }
  return _knownStation;
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

/**
 * BoT agencies map (agency_id → record) from the committed snapshot, memoized.
 * Feeds the booking-CTA tiering with agency_fare_url / agency_url so the static
 * pages resolve the same link the map's detail panel would. Missing file → {}
 * (curated booking config still applies).
 */
function getAgencies() {
  if (!_agencies) {
    try {
      _agencies = readJson(AGENCIES_PATH).data || {};
    } catch {
      _agencies = {};
    }
  }
  return _agencies;
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

/** { byRouteId, bySlug } legacy per-train slug maps (memoized). */
function getSlugMaps() {
  if (!_slugMaps) _slugMaps = buildRouteSlugMaps(getPublished().viewMap);
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
    // Synthetic operators (Amtrak, VIA Rail, …) declare their own countries via
    // OPERATOR_COUNTRY_FALLBACK. Their stations are NOT in the Back-on-Track
    // stop index, so looking their names up there only yields FALSE hits from
    // same-named European stations (e.g. the Amtrak stop "Toledo" matching
    // Toledo, Spain, which used to spawn a bogus /night-trains/spain hub). So
    // for these operators we trust the fallback and never look up their
    // American (or other synthetic) stations in Back-on-Track.
    const fallback = [];
    for (const opId of operatorIds) {
      for (const code of OPERATOR_COUNTRY_FALLBACK[opId] || []) {
        fallback.push(normalizeCountryCode(code));
      }
    }
    if (fallback.length) {
      for (const code of fallback) codes.add(code);
    } else {
      // Regular operators: derive the countries from the stations they pass
      // through, using the Back-on-Track stop→country index.
      const idx = getStopCountryIndex();
      for (const name of allStopNames) {
        const code = idx.get(String(name).toLowerCase());
        if (code) codes.add(code);
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
  // Labelled the way the operator writes the train — European Sleeper's feed
  // publishes ES 400 bare as "400". Display only: the raw trip_short_name is
  // what the timetable lookup and the enrichment match on.
  const trainNumbers = [route.trip_short_name_0, route.trip_short_name_1]
    .map((t) => formatTrainNumber(t, route.agency_id))
    .filter(Boolean);

  const stopNames = new Set();
  const cityPairs = [];
  for (const dir of [0, 1]) {
    const o = route[`origin_trip_${dir}`];
    const d = route[`destination_trip_${dir}`];
    if (o) stopNames.add(o);
    if (d) stopNames.add(d);
    for (const v of parseViaList(route[`via_${dir}`], getKnownStation())) {
      stopNames.add(v);
    }
    if (o && d) {
      cityPairs.push({
        originCity: cityForStation(o),
        destCity: cityForStation(d),
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
  const durationMinutes = routeDurationMinutes(route, factTrip);
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

  // The connection page this route lives on. Computed here rather than via
  // aggregate.js (which imports this module) so route cards can link to
  // /connections/ without a circular import. Every route has one — see
  // MIN_TRAINS_PER_PAIR in aggregate.js.
  const firstPair = cityPairs.find(
    (p) => p.originCity && p.destCity && p.originCity !== p.destCity,
  );
  const pairSlug = firstPair ? buildPairSlug(firstPair.originCity, firstPair.destCity) : "";

  return {
    routeId,
    slug,
    pairSlug,
    title: deriveTitle(route, origin, destination),
    endpointTitle,
    routeName,
    origin,
    destination,
    originCity: cityForStation(origin),
    destinationCity: cityForStation(destination),
    trainNumber: formatTrainNumber(trainNumber, route.agency_id),
    trainNumbers,
    agencyId: route.agency_id || "",
    // Pass the committed BoT agencies snapshot so getOperatorMeta can fall
    // back to agency_name when an id is missing from the curated table.
    operators: operatorIds.map((id) => getOperatorMeta(id, getAgencies())),
    operatorIds,
    countries,
    cityPairs,
    durationMinutes,
    durationText: formatDurationMinutes(durationMinutes),
    pricing,
    fromPrice: formatFromPrice(pricing),
    // "YYYY-MM-DD" or "" — every hub page's lastmod is the max over its routes.
    lastChanged: getRouteHistory()[String(routeId)]?.lastChanged || "",
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
    pairSlug: s.pairSlug || "",
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
    const via = parseViaList(route[`via_${dir}`], getKnownStation());
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
        code: s.code || null,
        lat: Number.isFinite(s.lat) ? s.lat : null,
        lon: Number.isFinite(s.lon) ? s.lon : null,
        departure: formatAnyTime(s.departure),
        arrival: formatAnyTime(s.arrival),
      }));
      // Endpoint times prefer the gated viewMap value over the live feed —
      // and the OTHER endpoint field has to go, or the row and the feed each
      // answer half of the same stop. A journey does not arrive where it
      // starts or depart from where it ends, so those two fields carry no
      // meaning at all; what they carried was the feed trip's own value
      // sitting beside a row value from a different trip. Paris–Aurillac
      // showed it plainly: `{"departure":"19:28","arrival":"18:27"}` on the
      // origin, two trips in one stop. The fallback branch below already
      // writes "" there; this is the same rule, applied where the feed wins.
      if (vmDeparture) stops[0].departure = vmDeparture;
      if (vmArrival) stops[stops.length - 1].arrival = vmArrival;
      stops[0].arrival = "";
      stops[stops.length - 1].departure = "";
    } else {
      const names = [origin, ...via, destination].filter(Boolean);
      stops = names.map((name, i) => {
        const c = coords.get(name);
        return {
          name,
          code: null,
          lat: c ? c[0] : null,
          lon: c ? c[1] : null,
          departure: i === 0 ? vmDeparture : "",
          arrival: i === names.length - 1 ? vmArrival : "",
        };
      });
    }

    // "Official timetable" helper, resolved per direction so each train links
    // to its own schedule. Keyed to who OPERATES the train (bot_agency_id),
    // not who sells it — the booking CTA above already answers that.
    const schedule = resolveScheduleLink({
      agencyId: route.bot_agency_id || route.agency_id || "",
      agencies: getAgencies(),
      train: route[`trip_short_name_${dir}`],
      routeId: String(routeId),
      originCountry: route[`origin_country_${dir}`],
      destCountry: route[`destination_country_${dir}`],
      originCode: route[`schedule_origin_code_${dir}`],
    });

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
      scheduleUrl: schedule?.url ?? null,
      scheduleLabel: schedule?.label ?? null,
      scheduleAffiliate: Boolean(schedule?.affiliate),
    });
  }

  // Facts come from the direction-0 trip when present.
  const factTrip = trips.find((t) => Number(t.direction_id) === 0) || trips[0] || null;
  const facts = {
    durationText: formatDurationMinutes(routeDurationMinutes(route, factTrip)),
    distanceText: factTrip ? formatDistanceKm(factTrip.distance) : "",
    co2Text: factTrip ? formatCo2(factTrip.emissions_co2e) : "",
    classes: (factTrip && factTrip.classes ? String(factTrip.classes) : "").trim(),
  };

  // Map geometry: encoded polylines (preferred) + station markers from every
  // direction's resolved stops (operator coords, else name lookup), merged and
  // deduped by name. Direction-0-only markers dropped the stations only the
  // return leg calls at — NJ 403 Amsterdam→Zürich runs via Eindhoven Centraal
  // while NJ 402 Zürich→Amsterdam runs via Arnhem Centraal, so Eindhoven
  // printed in direction 1's timetable below with no marker on the map above.
  const primary = directions[0] || {};
  const mapStopsByName = new Map();
  for (const dir of directions) {
    for (const s of dir.stops || []) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      if (!mapStopsByName.has(s.name)) {
        mapStopsByName.set(s.name, { name: s.name, lat: s.lat, lon: s.lon });
      }
    }
  }
  const mapStops = [...mapStopsByName.values()];
  // The two actual termini, so the map can mark them regardless of where the
  // merge above happened to place them in the array — merging by insertion
  // order put Eindhoven Centraal (unique to direction 1's stop list) last,
  // which flagged it as the route's endpoint instead of Amsterdam Centraal.

  // Booking CTA: the same tiered resolution the map's detail panel runs, but
  // at build time against the committed agencies snapshot, so the static HTML
  // carries the link. Enriched with the curated "from" price for display.
  const agencies = getAgencies();
  const resolvedBooking = resolveRouteBooking({
    agencyId: route.agency_id || "",
    agencies,
    agencyUrl: agencies[route.agency_id]?.agency_url ?? null,
    origin: primary.origin || summary.origin,
    dest: primary.destination || summary.destination,
    routeId: String(routeId),
    scheduleStops: primary.stops || [],
  });
  const booking = resolvedBooking
    ? { ...resolvedBooking, fromPrice: summary.fromPrice || null }
    : null;

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
    booking,
    countryCodes: summary.countries,
    countries: summary.countries.map(getSeoCountry).filter(Boolean),
    directions,
    facts,
    map: {
      polyline0: route.nj_polyline_0 || null,
      polyline1: route.nj_polyline_1 || null,
      stops: mapStops,
      originName: primary.origin || summary.origin,
      destinationName: primary.destination || summary.destination,
    },
  };
}
