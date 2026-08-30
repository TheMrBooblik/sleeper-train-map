/**
 * Resolve each train's stop-by-stop timetable at build time.
 *
 * On the web this is the most expensive thing the detail panel does:
 * `TrainDetailPanel` fetches up to nine operator feeds, normalises each into a
 * common stop shape, and picks a winner by a fixed precedence. That is ~500
 * lines of fetch orchestration and 24 pieces of component state, all to answer a
 * question whose inputs are committed files that change once a night.
 *
 * So it is answered here instead, once, and the app renders a static list.
 *
 * Two things this must reproduce exactly, because getting either wrong is
 * invisible until someone reads a timetable:
 *
 * 1. **Precedence** (`TrainDetailPanel.js:1409-1420`):
 *      pkp → rjGtfs (by number, then by endpoints) → nightjet → chinese →
 *      italian → caucasus → curated → northAmerica → europeanSleeper
 *    `cdSchedule` is deliberately NOT in that chain — it renders as its own
 *    second accordion (`:1377-1380`, `:1789`), so a ČD EuroNight can show two.
 *
 * 2. **Time zones.** `formatTime` (`:792-800`) renders in the *browser's* zone,
 *    and the feeds disagree about what their strings mean:
 *      - nightjet, italian → real instants ("2026-08-31T17:06:00.000Z")
 *      - europeansleeper, chinese → ISO without a zone, i.e. floating local
 *      - amtrak, viarail, cd, pkp, rjGtfs, caucasus → plain "HH:MM"
 *    Pre-formatting an instant in a UTC CI runner would show Bruxelles Midi at
 *    17:06 instead of 19:06. So an instant is passed through verbatim and the
 *    schedule is tagged `tz: "utc"` for the app to localise; everything else is
 *    reduced to a wall clock string and tagged `tz: "wall"`.
 *
 * Raw node. Covered by tests/verify-mobile-payload.mjs.
 */

import {
  esScheduleForTrip,
  isEuropeanSleeperTrip,
} from "../../src/lib/europeanSleeper.mjs";

/** Feeds whose stop times are real instants and must be localised on device. */
const UTC_SOURCES = new Set(["nightjet", "it"]);

/**
 * Feeds the web deliberately renders without times: the scrape carries ISO
 * strings for 12306 but they are the *query* date, not a published timetable,
 * and the Caucasus operators publish no per-stop times at all.
 * (`TrainDetailPanel.js:854-855`, `:900-901`.)
 */
const TIMELESS_SOURCES = new Set(["cr", "caucasus"]);

const normalizeTrainNumber = (value) =>
  (value || "").toString().trim().toUpperCase();

const extractTrainNumberDigits = (value) => {
  const match = normalizeTrainNumber(value).match(/\d{3,5}/);
  return match ? match[0] : "";
};

/** True for a string that names an instant — has `Z` or a UTC offset. */
const isAbsoluteInstant = (value) =>
  /T/.test(value) && /(Z|[+-]\d{2}:?\d{2})$/.test(String(value).trim());

/**
 * Reduce a feed value to the wall clock the browser would print for it.
 *
 * A floating ISO string ("2026-08-30T15:45:00") is parsed by JS as local time
 * and formatted back in local time, so the digits survive the round trip — which
 * means the substring is the answer, and reading it that way keeps the build
 * runner's own zone out of the result entirely.
 */
function toWallClock(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const hhmm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (hhmm) return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  return null;
}

/** `{ uploadedAt, data: { trains } }` is how the scrape runner stores a feed. */
const unwrapFeed = (blob) => {
  const inner = blob?.data && !blob.trains ? blob.data : blob;
  return inner?.trains && typeof inner.trains === "object" ? inner.trains : {};
};

/**
 * One feed → `Map<normalized train number, {stops, source, tz, days}>`.
 *
 * Every feed except European Sleeper and ČD is keyed by an operator-prefixed
 * number ("NJ 469", "ICN 752", "Z 21", "GR 1") or a service name ("Crescent"),
 * which is what keeps a bare number from matching across operators. The two that
 * are keyed bare get explicit guards at lookup time.
 */
function indexStationFeed(trains, source) {
  const out = new Map();
  const utc = UTC_SOURCES.has(source);
  const timeless = TIMELESS_SOURCES.has(source);

  for (const [key, train] of Object.entries(trains)) {
    const stations = Array.isArray(train?.stations) ? train.stations : [];
    if (stations.length === 0) continue;

    const stops = stations.map((s) => {
      const name = s.name || s.id || "Station";
      if (timeless) return [name, null, null];
      const pick = (v) => (utc ? v || null : toWallClock(v));
      return [name, pick(s.arrival), pick(s.departure)];
    });

    out.set(normalizeTrainNumber(key), {
      src: source,
      tz: utc ? "utc" : "wall",
      stops,
      days: train.frequency || null,
    });
  }
  return out;
}

/** European Sleeper is split by timetable period; see src/lib/europeanSleeper.mjs. */
function indexEuropeanSleeper(trains) {
  const current = new Map();
  const upcoming = new Map();
  for (const [key, train] of Object.entries(trains)) {
    const number = normalizeTrainNumber(key);
    const build = (stations, days) => ({
      src: "europeansleeper",
      tz: "wall",
      stops: stations.map((s) => [
        s.name || "Station",
        toWallClock(s.arrival),
        toWallClock(s.departure),
      ]),
      days: days || null,
    });
    const stations = Array.isArray(train?.stations) ? train.stations : [];
    if (stations.length > 0)
      current.set(number, build(stations, train.frequency));
    const future = train?.future;
    const futureStations = Array.isArray(future?.stations)
      ? future.stations
      : [];
    if (futureStations.length > 0) {
      upcoming.set(number, build(futureStations, future.frequency));
    }
  }
  return { current, upcoming };
}

/**
 * ČD, keyed by bare number in the feed but carrying its own label ("EN 345").
 * Matching on the label rather than the digits is what stops an unrelated 345
 * from being dressed in ČD's stops — the same bare-number hazard the European
 * Sleeper guard exists for.
 */
function indexCd(trains) {
  const out = new Map();
  for (const [key, train] of Object.entries(trains)) {
    const stops = Array.isArray(train?.stops) ? train.stops : [];
    if (stops.length === 0) continue;
    const entry = {
      src: "cd",
      tz: "wall",
      stops: stops.map((s) => [
        s.name || "Station",
        toWallClock(s.arrival),
        toWallClock(s.departure),
      ]),
      days: null,
    };
    const label = normalizeTrainNumber(train.trainLabel);
    if (label) out.set(label, entry);
    // The digits stay addressable so an `EC 345`/`EN 345` mismatch between the
    // feed's label and Back-on-Track's number still resolves — but only for a
    // trip the caller has already confirmed is EC/EN.
    const digits = extractTrainNumberDigits(key);
    if (digits) out.set(`#${digits}`, entry);
  }
  return out;
}

/** RegioJet GTFS timetables: `{ trips: [{ trainNumber, stops:[{name,arrival,departure}] }] }`. */
function indexRjGtfs(...bundles) {
  const byNumber = new Map();
  const all = [];
  for (const bundle of bundles) {
    for (const trip of bundle?.trips || []) {
      const stops = Array.isArray(trip?.stops) ? trip.stops : [];
      if (stops.length === 0) continue;
      const entry = {
        src: "rj_gtfs",
        tz: "wall",
        stops: stops.map((s) => [
          s.name || "Station",
          toWallClock(s.arrival),
          toWallClock(s.departure),
        ]),
        days: null,
      };
      all.push(entry);
      const full = normalizeTrainNumber(trip.trainNumber);
      const digits = extractTrainNumberDigits(trip.trainNumber);
      if (full) byNumber.set(full, entry);
      if (digits) byNumber.set(digits, entry);
    }
  }
  return { byNumber, all };
}

const normalizeStationToken = (value) =>
  (value || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** `TrainDetailPanel.js:185` — a loose containment match in either direction. */
function matchesEndpoint(stopName, tripEndpoint) {
  const a = normalizeStationToken(stopName);
  const b = normalizeStationToken(tripEndpoint);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/** PKP's per-station timetable, already merged onto the route row by pkpGtfsMerge. */
function pkpScheduleForRow(row, direction) {
  const stops = direction === 1 ? row?.pkp_schedule_1 : row?.pkp_schedule_0;
  if (!Array.isArray(stops) || stops.length === 0) return null;
  const valid = direction === 1 ? row?.pkp_valid_1 : row?.pkp_valid_0;
  return {
    src: "pkp",
    tz: "wall",
    stops: stops.map((s) => [
      s.name || "Station",
      toWallClock(s.arr),
      toWallClock(s.dep),
    ]),
    days: valid?.days || null,
    validFrom: valid?.validFrom || null,
    validUntil: valid?.validUntil || null,
  };
}

/**
 * Build the resolver.
 *
 * @param {object} feeds  raw parsed feed blobs, keyed by scrape name
 * @returns {{resolve: Function, sourceCounts: Function}}
 */
export function createScheduleResolver(feeds = {}) {
  const nightjet = indexStationFeed(unwrapFeed(feeds.nightjet), "nightjet");
  const chinese = indexStationFeed(unwrapFeed(feeds.chinese), "cr");
  const italian = indexStationFeed(unwrapFeed(feeds.italian), "it");
  const caucasus = indexStationFeed(unwrapFeed(feeds.caucasus), "caucasus");
  const curated = indexStationFeed(unwrapFeed(feeds.curated), "curated");
  const northAmerica = new Map([
    ...indexStationFeed(unwrapFeed(feeds.amtrak), "na"),
    ...indexStationFeed(unwrapFeed(feeds.viarail), "na"),
  ]);
  const es = indexEuropeanSleeper(unwrapFeed(feeds.europeansleeper));
  const cd = indexCd(unwrapFeed(feeds.cd));
  const rj = indexRjGtfs(feeds.rjChop, feeds.rjPremysl);

  const counts = new Map();
  const bump = (src) => counts.set(src, (counts.get(src) || 0) + 1);

  /**
   * @param {object} args
   * @param {object} args.row        the viewMap row
   * @param {object|null} args.trip  the matching trip, when there is one
   * @param {number} args.direction  0 or 1
   * @param {string} args.trainNumber
   * @returns {{schedule: object|null, cdSchedule: object|null}}
   */
  function resolve({ row, trip, direction, trainNumber }) {
    const number = normalizeTrainNumber(trainNumber);
    const digits = extractTrainNumberDigits(trainNumber);
    const routeId = String(row?.route_id ?? "");

    // The panel gates each feed on a train-number or route-id pattern before it
    // is ever consulted. Reproducing the gates matters even though most feeds
    // are prefix-keyed: it is what keeps an Amtrak service name or a bare number
    // from reaching a feed that never claimed it.
    const isNjOrEn = /^\s*(NJ|EN)\s+\d+/i.test(number);
    const isCr = /^\s*(Z|T|K|D)\s+\d+/i.test(number);
    const isIcn = /^\s*ICN\s+\d+/i.test(number);
    const isCaucasus = /^\s*(GR|ADY|SCR)\s+\d+/i.test(number);
    const isCurated = routeId.startsWith("curated_");
    const isNorthAmerica =
      routeId.startsWith("amtrak_") || routeId.startsWith("via_");
    const isEc = /^\s*E[CN]\s+\d+/i.test(number);

    const rjByNumber =
      rj.byNumber.get(number) || rj.byNumber.get(digits) || null;
    const rjByEndpoints =
      !rjByNumber && trip
        ? rj.all.find(
            (candidate) =>
              candidate.stops.length >= 2 &&
              matchesEndpoint(candidate.stops[0][0], trip.trip_origin) &&
              matchesEndpoint(
                candidate.stops[candidate.stops.length - 1][0],
                trip.trip_headsign,
              ),
          ) || null
        : null;

    // European Sleeper's feed is keyed by BARE number, and Back-on-Track carries
    // a CFM/CFR 401 and an SJN 475 next to ES 401/475 — hence the agency guard.
    const esTrip = trip || {
      route_id: row?.route_id,
      agency_id: row?.agency_id,
    };
    const esSchedule = isEuropeanSleeperTrip(esTrip)
      ? esScheduleForTrip(esTrip, es, number)
      : null;

    const schedule =
      pkpScheduleForRow(row, direction) ||
      rjByNumber ||
      rjByEndpoints ||
      (isNjOrEn ? nightjet.get(number) : null) ||
      (isCr ? chinese.get(number) : null) ||
      (isIcn ? italian.get(number) : null) ||
      (isCaucasus ? caucasus.get(number) : null) ||
      (isCurated ? curated.get(number) : null) ||
      (isNorthAmerica ? northAmerica.get(number) : null) ||
      esSchedule ||
      null;

    // Its own accordion, not part of the chain above.
    const cdSchedule =
      cd.get(number) || (isEc && digits ? cd.get(`#${digits}`) : null) || null;

    if (schedule) bump(schedule.src);
    if (cdSchedule) bump("cd");

    return { schedule: schedule || null, cdSchedule };
  }

  return {
    resolve,
    sourceCounts: () => Object.fromEntries([...counts].sort()),
    feedSizes: () => ({
      nightjet: nightjet.size,
      cr: chinese.size,
      it: italian.size,
      caucasus: caucasus.size,
      curated: curated.size,
      na: northAmerica.size,
      europeansleeper: es.current.size + es.upcoming.size,
      cd: cd.size,
      rj_gtfs: rj.all.length,
    }),
  };
}

export {
  toWallClock,
  isAbsoluteInstant,
  matchesEndpoint,
  normalizeTrainNumber,
};
