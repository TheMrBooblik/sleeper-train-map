/**
 * The planner's view of the dataset: a directed graph of night-train legs.
 *
 * The map draws routes; the planner has to answer "can I sleep my way from here
 * to there", which is a different question about the same rows. One viewMap row
 * is TWO legs — a route's two directions have their own stops, times and
 * operating days, and treating them as one is how a planner tells you the
 * outbound runs on a night only the return does.
 *
 * Every stop on a leg is a boarding and an alighting point, not only the
 * endpoints. That is not a nicety: from Amsterdam the endpoint-to-endpoint
 * reading offers 5 destinations, and the full stop chain offers 82 — Berlin and
 * Prague among them, which is the difference between the product working and
 * not. What the endpoints do have that intermediate stops do not is a TIME, so
 * a segment reports times only for the ends it actually knows (see segmentOf).
 */

import { cityForStation } from "../seo/cities.mjs";
import { slugify } from "../seo/slugify.mjs";
import { splitViaString } from "../viaSplit.mjs";
import { parseBotServiceString, renderCalendar } from "../../pages/api/lib/calendar.mjs";

/** "HH:MM" (or an ISO/T-prefixed time) → minutes since midnight, else null. */
export function toMinutes(value) {
  const m = String(value ?? "").match(/(?:^|T)(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 47 || min > 59) return null;
  return (h % 24) * 60 + min;
}

/** "HH:MM" for display, or "" — never a half-parsed string. */
function toClock(value) {
  const mins = toMinutes(value);
  if (mins == null) return "";
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Journey length from the two endpoint clocks, wrapping past midnight — the
 * same rule routeDurationMinutes() uses for the connection pages, so the two
 * surfaces cannot disagree about one train.
 */
function durationBetween(departure, arrival) {
  const dep = toMinutes(departure);
  const arr = toMinutes(arrival);
  if (dep == null || arr == null) return null;
  const span = arr - dep;
  return span > 0 ? span : span + 24 * 60;
}

/**
 * A row's placeholder times. Back-on-Track writes 00:00 → 00:00 for a train it
 * lists without a timetable; read literally that is a 24-hour journey leaving
 * at midnight, which is worse than admitting we do not know.
 */
function hasRealTimes(departure, arrival) {
  return !(toClock(departure) === "00:00" && toClock(arrival) === "00:00");
}

/** agency_id may be compound ("MÁV/ÖBB", "CFM/CFR"). */
function splitAgencies(value) {
  return String(value || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the leg list from a published `{ stops, viewMap, trips }` payload.
 *
 * @param {object} payload
 * @param {object} [options]
 * @param {(routeId: string, direction: number) => string} [options.pairSlugFor]
 *   Connection-page slug for a leg, so a result can link to the page that
 *   already carries the timetable, booking CTA and FAQ. Omitted → no link.
 * @param {(route: object) => object|null} [options.pricingFor]
 *   The route's pricing record. Injected rather than imported because
 *   operatorPricing.js cannot load in raw node (see pricingResolve.mjs).
 * @param {(leg: {train: string, origin: string, destination: string}) => Map<string, {arrival: string, departure: string}>|null} [options.stopTimesFor]
 *   Per-stop times from an operator feed, keyed by station name. Optional
 *   because only the build has the raw feeds on disk; without it the graph is
 *   the same graph with fewer clocks on it.
 * @returns {{legs: object[], cities: object[]}}
 */
export function buildLegs(payload, options = {}) {
  const { stops = [], viewMap = {}, trips = {} } = payload || {};

  // splitViaString needs to know what a station is, or "Rocamadour - Padirac"
  // becomes two places that do not exist. Same predicate the payload projection
  // and the SEO layer use.
  const knownStations = new Set(
    stops.map((s) => String(s?.stop_name || "").trim().toLowerCase()).filter(Boolean),
  );
  const isKnownStation = (name) => knownStations.has(String(name).trim().toLowerCase());

  const countryOf = new Map();
  for (const stop of stops) {
    const name = String(stop?.stop_name || "").trim();
    if (name && stop?.stop_country) countryOf.set(name.toLowerCase(), String(stop.stop_country));
  }

  const tripsByRoute = new Map();
  for (const trip of Object.values(trips)) {
    const id = String(trip?.route_id ?? "");
    if (!id) continue;
    if (!tripsByRoute.has(id)) tripsByRoute.set(id, []);
    tripsByRoute.get(id).push(trip);
  }

  const legs = [];
  const cityIndex = new Map();

  const noteCity = (name, station) => {
    const slug = slugify(name);
    if (!slug) return null;
    let entry = cityIndex.get(slug);
    if (!entry) {
      entry = { slug, name, country: "", stations: new Set(), legCount: 0 };
      cityIndex.set(slug, entry);
    }
    entry.stations.add(station);
    if (!entry.country) entry.country = countryOf.get(station.toLowerCase()) || "";
    return entry;
  };

  for (const route of Object.values(viewMap)) {
    const routeId = String(route?.route_id ?? "");
    if (!routeId) continue;
    const routeTrips = tripsByRoute.get(routeId) || [];

    for (const direction of [0, 1]) {
      const origin = String(route[`origin_trip_${direction}`] || "").trim();
      const destination = String(route[`destination_trip_${direction}`] || "").trim();
      if (!origin || !destination) continue;

      const via = splitViaString(route[`via_${direction}`] || "", isKnownStation);
      const chain = [origin, ...via, destination];

      const train = String(route[`trip_short_name_${direction}`] || "").trim();
      const feedTimes =
        options.stopTimesFor?.({ train, origin, destination, routeId, direction }) || null;

      const stopList = [];
      const seenCities = new Set();
      for (const station of chain) {
        const city = cityForStation(station);
        const entry = noteCity(city, station);
        if (!entry) continue;
        // A train that calls twice in one city (Berlin Spandau then Berlin Hbf)
        // is one place to board, listed once, at its first call.
        if (seenCities.has(entry.slug)) continue;
        seenCities.add(entry.slug);
        const feed = feedTimes?.get(station) || null;
        stopList.push({
          station,
          city: entry.name,
          citySlug: entry.slug,
          arrival: toClock(feed?.arrival),
          departure: toClock(feed?.departure),
        });
      }
      if (stopList.length < 2) continue;

      const trip = routeTrips.find((t) => Number(t?.direction_id) === direction) || null;
      const serviceRaw = String(
        route[`service_id_${direction}`] || trip?.service_id || "",
      ).trim();
      const calendar = parseBotServiceString(serviceRaw);

      const rawDeparture = route[`origin_departure_time_${direction}`];
      const rawArrival = route[`destination_arrival_time_${direction}`];
      const timed = hasRealTimes(rawDeparture, rawArrival);
      const departure = timed ? toClock(rawDeparture) : "";
      const arrival = timed ? toClock(rawArrival) : "";

      const operatorIds = splitAgencies(route.bot_agency_id || route.agency_id);

      legs.push({
        id: `${routeId}:${direction}`,
        routeId,
        direction,
        train,
        operatorIds,
        stops: stopList,
        departure,
        arrival,
        durationMinutes: timed ? durationBetween(rawDeparture, rawArrival) : null,
        service: serviceRaw,
        serviceText: renderCalendar(calendar) || "",
        days: calendar.daysOfWeek,
        validFrom: calendar.validFrom,
        validUntil: calendar.validUntil,
        cadence: calendar.cadence,
        serviceNote: calendar.note,
        irregularity: String(route[`irregularities_${direction}`] || "").trim(),
        pairSlug: options.pairSlugFor?.(routeId, direction) || "",
        // The whole pricing record, not just a figure. No operator carries a
        // `fromPrice` today, but 21 declare a pricing MODEL, which is advice a
        // traveller can act on now ("book early" for a yield-managed sleeper),
        // and the figure renders through the same field the day a price probe
        // produces one.
        pricing: options.pricingFor?.(route) ?? null,
      });

      for (const slug of seenCities) cityIndex.get(slug).legCount++;
    }
  }

  const cities = [...cityIndex.values()]
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      country: c.country,
      legCount: c.legCount,
      stations: [...c.stations].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return { legs, cities };
}

/**
 * The part of a leg between two of its stops.
 *
 * A stop's own feed time wins where one exists. Otherwise times are reported
 * only for an end the ROW times — the origin's departure and the destination's
 * arrival — because boarding at an intermediate stop has no published time in
 * Back-on-Track's data, and guessing one from the endpoints would be a number
 * the operator never said.
 *
 * @param {object} leg
 * @param {number} boardIndex
 * @param {number} alightIndex
 * @returns {object|null} null when the two indices do not form a forward ride
 */
export function segmentOf(leg, boardIndex, alightIndex) {
  const stops = leg?.stops ?? [];
  if (!(boardIndex >= 0 && alightIndex > boardIndex && alightIndex < stops.length)) {
    return null;
  }
  const board = stops[boardIndex];
  const alight = stops[alightIndex];
  const fromEnd = boardIndex === 0;
  const toEnd = alightIndex === stops.length - 1;
  const departure = board.departure || (fromEnd ? leg.departure : "");
  const arrival = alight.arrival || (toEnd ? leg.arrival : "");
  // A duration needs both clocks; with either missing there is nothing to
  // measure and a made-up number is worse than a blank.
  const durationMinutes = departure && arrival ? durationBetween(departure, arrival) : null;
  return {
    from: board,
    to: alight,
    boardIndex,
    alightIndex,
    departure,
    arrival,
    durationMinutes,
    // Riding this segment means sleeping on the train. Amsterdam → Amersfoort
    // is a real call of a real sleeper and it is 36 minutes long, so offering
    // it beside Amsterdam → Prague as though they were the same kind of trip is
    // what makes an "overnight destinations" list read like a stopping pattern.
    isOvernight: isOvernightRide(departure, arrival, durationMinutes),
    // Where the train ENDS, regardless of where you got on. Distinct from
    // isWholeRoute, which also requires boarding at the origin: ES 453 runs
    // Brussels → Prague, so from Amsterdam Prague is the train's destination
    // while the ride is not the whole route. Ranking destinations on
    // isWholeRoute therefore filed Prague with the villages it passes at 3am.
    isTerminus: toEnd,
    isWholeRoute: fromEnd && toEnd,
    intermediate: stops.slice(boardIndex + 1, alightIndex),
  };
}

/**
 * Does this ride cross a night?
 *
 * Either it lands on a later calendar day (arrival clock at or before its own
 * departure), or it is long enough that it cannot be an evening hop. The
 * duration floor catches a leg with only one clock, where the wrap test has
 * nothing to compare.
 */
export function isOvernightRide(departure, arrival, durationMinutes) {
  if (departure && arrival) {
    const dep = toMinutes(departure);
    const arr = toMinutes(arrival);
    if (dep != null && arr != null && arr <= dep) return true;
  }
  return Number.isFinite(durationMinutes) && durationMinutes >= MIN_OVERNIGHT_MINUTES;
}

/** Five hours: below it a ride is an evening connection, not a night's sleep. */
const MIN_OVERNIGHT_MINUTES = 300;

/** citySlug → [{ leg, index }] for every leg calling there, built once. */
export function indexLegsByCity(legs) {
  const byCity = new Map();
  for (const leg of legs) {
    leg.stops.forEach((stop, index) => {
      if (!byCity.has(stop.citySlug)) byCity.set(stop.citySlug, []);
      byCity.get(stop.citySlug).push({ leg, index });
    });
  }
  return byCity;
}
