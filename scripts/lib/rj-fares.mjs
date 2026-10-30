// scripts/lib/rj-fares.mjs
// RegioJet night-train fare calendars, read from RegioJet's own booking API
// (brn-ybus-pubapi.sa.cz/restapi, no key — the backend regiojet.com searches
// with). Called from the gtfs-sleeper adapter when the registry entry declares
// `params.fares.provider: "regiojet"`, after the trains are built from the GTFS.
//
// Two calls, both what the site makes before anyone logs in:
//   GET /routes/search/simple?fromLocationId=…&fromLocationType=CITY&…&departureDate=YYYY-MM-DD
//     → the next three departures between two cities from that date on, each
//       with its route id and the two stations' ids. One search therefore
//       answers three nights.
//   GET /routes/{routeId}/simple?fromStationId=…&toStationId=…
//     → that night's `priceClasses`, one per kind of place, with its price
//       for one adult in the currency asked for (X-Currency).
// The location ids are RegioJet's booking CITY ids, which are the GTFS stops'
// zone_id and the same ids the Book button uses (operator-booking.json RJ
// stationNames) — so a train is priced between the two cities its button opens.
//
// Only berths are priced. A night's cheapest seat is kept beside the classes
// (`seat`, never a class) so credibleClasses can refuse a berth priced at or
// below it; women-only compartments are left out (the lefrecce/ES rule: only
// what any adult can buy). The figure is one adult's price for that place,
// which for a private compartment is the price of having it to yourself.

import fs from "node:fs";
import path from "node:path";
import {
  cheapestNight,
  FARE_CALENDAR_DAYS,
  planFareSearches,
  pruneCalendar,
} from "./fare-calendar.mjs";
import { detectBlock, describeBlock, HONEST_USER_AGENT } from "./http-block.mjs";
import { fetchWithTimeout } from "./scrape-helpers.mjs";

export const RJ_API = "https://brn-ybus-pubapi.sa.cz/restapi";

/** Nights searched per run: about 170 for six weeks of four trains. */
export const RJ_FARE_BUDGET = 200;
const RJ_SPACING_MS = 1000;
/** A search answer's departure must be within this of the train's own clock. */
const CLOCK_TOLERANCE_MIN = 20;

/**
 * RegioJet's sleeping places (`/consts/seatClasses`, October 2026) → our fare
 * classes. Women-only ones map to null: left out, not priced. A seatClassKey
 * absent from this table and naming a couchette is reported, never guessed.
 */
export const RJ_BERTH_CLASSES = {
  TRAIN_COUCHETTE_STANDARD: "couchette", // "Couchette", 6-berth compartment
  TRAIN_COUCHETTE_RELAX: "rjCouchette4", // "Berth", 4-berth compartment
  TRAIN_COUCHETTE_RELAX_FOR_WOMEN: null,
  TRAIN_COUCHETTE_RELAX_3: "rjSleeper3", // made-up beds, 3-person compartment
  TRAIN_COUCHETTE_RELAX_3_WOMEN: null,
  TRAIN_COUCHETTE_BUSINESS: "rjPrivate3", // own compartment, up to 3 people
  TRAIN_COUCHETTE_BUSINESS_4: "rjPrivate4", // own compartment, up to 4 people
};

const isBerthKey = (key) => /COUCHETTE|SLEEP/i.test(String(key ?? ""));

/** "2026-11-20T21:45:00.000+01:00" → { date: "2026-11-20", clock: "21:45" }, the station's own clock. */
export function localParts(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso ?? ""));
  return m ? { date: m[1], clock: m[2] } : null;
}

function minutesOf(clock) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(clock ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes between two clocks across midnight, 0–720. */
function clockGap(a, b) {
  const x = minutesOf(a);
  const y = minutesOf(b);
  if (x == null || y == null) return Infinity;
  const d = Math.abs(x - y) % 1440;
  return Math.min(d, 1440 - d);
}

/**
 * Our train's departures in one search answer, by night (the departure's own
 * local date): direct trains only, leaving within CLOCK_TOLERANCE_MIN of the
 * train's clock. Also returns the last night the answer reaches, since the
 * search runs forward: a night between the asked date and that one with no
 * match has no train. Pure; exported for tests.
 */
export function departuresByNight(answer, { clock }) {
  const nights = new Map();
  let last = null;
  for (const r of answer?.routes ?? []) {
    const dep = localParts(r?.departureTime);
    if (!dep) continue;
    if (!last || dep.date > last) last = dep.date;
    if (Number(r.transfersCount) !== 0) continue;
    const types = Array.isArray(r.vehicleTypes) ? r.vehicleTypes : [];
    if (types.length !== 1 || types[0] !== "TRAIN") continue;
    if (clockGap(dep.clock, clock) > CLOCK_TOLERANCE_MIN) continue;
    if (nights.has(dep.date)) continue;
    nights.set(dep.date, {
      routeId: String(r.id),
      fromStationId: r.departureStationId,
      toStationId: r.arrivalStationId,
      dep: String(r.departureTime).slice(0, 16),
      arr: String(r.arrivalTime ?? "").slice(0, 16) || null,
    });
  }
  return { nights, last };
}

/**
 * One night's classes from a route answer: the cheapest bookable place of
 * each berth class we price, the cheapest seat apart, and any berth key the
 * table does not know. Pure; exported for tests.
 */
export function berthClasses(route) {
  const classes = {};
  const products = {};
  const unmapped = new Set();
  let seat = null;
  for (const pc of route?.priceClasses ?? []) {
    const key = pc?.seatClassKey;
    const price = Number(pc?.price);
    if (!key || !Number.isFinite(price) || price <= 0) continue;
    if (pc.bookable === false || Number(pc.freeSeatsCount) === 0) continue;
    if (Object.hasOwn(RJ_BERTH_CLASSES, key)) {
      const cls = RJ_BERTH_CLASSES[key];
      if (!cls) continue;
      if (classes[cls] == null || price < classes[cls]) {
        classes[cls] = price;
        products[cls] = key;
      }
    } else if (isBerthKey(key)) {
      unmapped.add(key);
    } else if (seat == null || price < seat) {
      seat = price;
    }
  }
  return { classes, products, seat, unmapped: [...unmapped] };
}

function loadCityIds(rootDir) {
  try {
    const booking = JSON.parse(
      fs.readFileSync(path.join(rootDir, "data", "overrides", "operator-booking.json"), "utf8"),
    );
    return booking?.RJ?.stationNames ?? {};
  } catch {
    return {};
  }
}

async function getJson(url, { fetchImpl, currency }) {
  const res = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "User-Agent": HONEST_USER_AGENT,
      "X-Currency": currency,
      "X-Lang": "en",
    },
  });
  const body = await res.text();
  const block = detectBlock({ status: res.status, headers: res.headers, body });
  if (block) {
    const err = new Error(`blocked: ${describeBlock(block)}`);
    err.block = block;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("answer is not JSON");
  }
}

export function searchUrl({ fromCity, toCity, date }) {
  return (
    `${RJ_API}/routes/search/simple?fromLocationId=${encodeURIComponent(fromCity)}` +
    `&fromLocationType=CITY&toLocationId=${encodeURIComponent(toCity)}` +
    `&toLocationType=CITY&departureDate=${date}&tariffs=REGULAR`
  );
}

export function routeUrl({ routeId, fromStationId, toStationId }) {
  return (
    `${RJ_API}/routes/${encodeURIComponent(routeId)}/simple` +
    `?fromStationId=${encodeURIComponent(fromStationId)}&toStationId=${encodeURIComponent(toStationId)}&tariffs=REGULAR`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring every train's fare calendar up to date within tonight's budget and
 * set its headline fare to its cheapest night (scripts/lib/fare-calendar.mjs).
 * Never throws. A block ends the pass at once and keeps what was read; a 4xx
 * skips that train for the night; five failures in a row stop the pass.
 */
export async function fillRjFareCalendars(
  trains,
  previousTrains,
  {
    today,
    rootDir,
    fetchImpl = fetchWithTimeout,
    log = console.log,
    currency = "EUR",
    days = FARE_CALENDAR_DAYS,
    budget = RJ_FARE_BUDGET,
    spacingMs = RJ_SPACING_MS,
    maxConsecutiveErrors = 5,
    cityIds = loadCityIds(rootDir ?? process.cwd()),
  } = {},
) {
  const stats = {
    planned: 0, requests: 0, priced: 0, noBerth: 0, noJourney: 0, errors: 0,
    stopped: false, blocked: null, unmapped: new Set(), unpriceable: [],
  };
  const ends = {};
  const calendars = {};
  for (const [key, train] of Object.entries(trains)) {
    const first = train.stations?.[0];
    const last = train.stations?.[train.stations.length - 1];
    const fromCity = cityIds[first?.name];
    const toCity = cityIds[last?.name];
    const clock = first?.departure;
    if (!fromCity || !toCity || minutesOf(clock) == null) {
      stats.unpriceable.push(`${key} (${first?.name} → ${last?.name})`);
      continue;
    }
    ends[key] = { fromCity, toCity, clock };
    const previous = previousTrains?.[key]?.fareCalendar ?? { currency, nights: {} };
    calendars[key] = pruneCalendar(previous, { today, days });
    calendars[key].currency ??= currency;
  }
  if (stats.unpriceable.length) {
    log(`[rj-fare] no RegioJet city id for ${stats.unpriceable.join(", ")} — add it to operator-booking.json RJ stationNames`);
  }

  const plan = planFareSearches(calendars, { today, days, budget, nearDays: 7 });
  stats.planned = plan.length;
  // trainKey → date → departure, from the searches made tonight.
  const found = new Map();
  const searchedThrough = new Map();
  const skip = new Set();
  let consecutiveErrors = 0;

  const request = async (url) => {
    stats.requests++;
    try {
      return await getJson(url, { fetchImpl, currency });
    } finally {
      if (spacingMs) await sleep(spacingMs);
    }
  };

  for (const { key, date } of plan) {
    if (stats.blocked) break;
    if (skip.has(key)) continue;
    const cal = calendars[key];
    try {
      if (!found.has(key)) found.set(key, new Map());
      const known = found.get(key);
      const through = searchedThrough.get(key);
      if (!known.has(date) && !(through && date >= through.from && date <= through.to)) {
        const answer = await request(searchUrl({ ...ends[key], date }));
        const { nights, last } = departuresByNight(answer, ends[key]);
        for (const [night, dep] of nights) known.set(night, dep);
        // The search runs forward from `date`, so every night up to the last
        // one it reached without our train has none.
        searchedThrough.set(key, { from: date, to: last ?? date });
      }
      const dep = known.get(date);
      if (!dep) {
        cal.nights[date] = { none: true, reason: "noJourney", checkedAt: today };
        stats.noJourney++;
        consecutiveErrors = 0;
        continue;
      }
      const route = await request(routeUrl(dep));
      // `products` (RegioJet's seatClassKey per class) stays out of the
      // calendar: the page prints a night's `offers` as the product to look
      // for in the shop (Nightjet's "Sparschiene"), and RegioJet's shop never
      // shows these keys.
      const { classes, seat, unmapped } = berthClasses(route);
      for (const u of unmapped) stats.unmapped.add(u);
      consecutiveErrors = 0;
      if (!Object.keys(classes).length) {
        cal.nights[date] = { none: true, reason: "noBerth", checkedAt: today };
        stats.noBerth++;
        continue;
      }
      cal.nights[date] = {
        classes,
        ...(seat != null ? { seat } : {}),
        dep: dep.dep,
        arr: dep.arr,
        checkedAt: today,
      };
      stats.priced++;
    } catch (err) {
      if (err.block) {
        stats.blocked = describeBlock(err.block);
        log(`[rj-fare] ${key} ${date}: ${err.message} — stopping tonight's fare searches`);
        break;
      }
      stats.errors++;
      consecutiveErrors++;
      if (err.status >= 400 && err.status < 500) skip.add(key);
      log(`[rj-fare] ${key} ${date}: ${err.message}${skip.has(key) ? " — skipping its other nights tonight" : ""}`);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        stats.stopped = true;
        log(`[rj-fare] ${consecutiveErrors} failures in a row — stopping tonight's fare searches`);
        break;
      }
    }
  }

  if (stats.unmapped.size) {
    log(`[rj-fare] berth classes not priced (unknown to RJ_BERTH_CLASSES): ${[...stats.unmapped].sort().join(", ")}`);
  }
  for (const [key, cal] of Object.entries(calendars)) {
    cal.nights = Object.fromEntries(Object.entries(cal.nights).sort(([a], [b]) => (a < b ? -1 : 1)));
    const entries = Object.values(cal.nights);
    if (!entries.length) continue;
    trains[key].fareCalendar = cal;
    const fare = cheapestNight(cal);
    if (fare) trains[key].fare = fare;
    const priced = entries.filter((e) => !e.none).length;
    log(
      `[rj-fare] ${key}: ${priced}/${entries.length} night(s) priced` +
        (fare ? `, cheapest ${fare.currency} ${fare.fromPrice} (${fare.seatClass}) on ${fare.travelDate}` : ""),
    );
  }
  stats.unmapped = [...stats.unmapped];
  return stats;
}

/** The previous run's trains file, for the calendar to build on. */
export function readPreviousTrains(rootDir, output) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, "public", "data", "scraped", output), "utf8"));
    return raw?.data?.trains ?? raw?.trains ?? null;
  } catch {
    return null;
  }
}

