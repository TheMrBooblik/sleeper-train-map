// scripts/lib/rj-fares.mjs
// RegioJet night-train fares for every night of the next six weeks, from
// RegioJet's own public booking API (brn-ybus-pubapi.sa.cz/restapi) — the
// JSON backend of regiojet.com's search, no key, no login.
//
// RegioJet's GTFS (scripts/lib/regiojet.mjs) carries no fares, but it carries
// the booking system's own ids: a parent stop_id is the API's STATION id
// (Praha hl.n. = 372825000) and the zone_id its CITY id (Praha = 10202003, the
// id regiojet.com's own links use). So each train is priced between its two
// ends exactly as the site searches it, with nothing to look up by name:
//
//   1. GET /routes/search/simple?fromLocationId=…&fromLocationType=STATION
//        &toLocationId=…&toLocationType=STATION&departureDate=YYYY-MM-DD
//        &tariffs=REGULAR
//      → { routes: [{ id, departureTime, arrivalTime, transfersCount,
//          vehicleTypes, priceFrom, … }] }: every connection that day. Ours is
//      the direct train leaving at the feed's own departure minute (±2).
//      None means no train that night (`reason: "noJourney"`).
//   2. GET /routes/{id}/simple?fromStationId=…&toStationId=…&tariffs=REGULAR
//      → the connection with `priceClasses: [{ seatClassKey, price,
//          freeSeatsCount, bookable, … }]`: one price per kind of place.
//
// Only what one standard adult (tariff REGULAR) can buy for a bed is priced:
// couchettes and sleepers, by the kind of place each `seatClassKey` names —
// read off the key and the title GET /consts/seatClasses gives it, in English,
// Czech or Slovak (`classifySeatClass`). Seats are never a class: the cheapest
// one is kept beside the night as `seat`, which is what `credibleClasses`
// checks a berth against (a "couchette" at or below the seat is a seat price
// under a berth's name, and no reader quotes it). Ladies-only compartments are
// left out (the same berth at the same price, sold to half the travellers),
// and so is a place with no free berth. `priceFrom` from the search is never
// read: it is the cheapest place of any kind, seats included.
//
// The request and answer shapes follow the API as regiojet.com uses it and
// the open clients that read it; ybus hosts are unreachable from a dev
// sandbox, so the reader is strict (an answer without `routes`, or a
// connection without `priceClasses`, is an error, never "no train") and
// `npm run probe-regiojet` prints the raw answers from a runner (label a PR
// `run-probes`).

import { fetchWithTimeout } from "./scrape-helpers.mjs";
import { HONEST_USER_AGENT, describeBlock, detectBlock } from "./http-block.mjs";
import { FARE_CALENDAR_DAYS, cheapestNight, planFareSearches, pruneCalendar } from "./fare-calendar.mjs";

export const RJ_API = "https://brn-ybus-pubapi.sa.cz/restapi";

/** Requests per run: two per night priced (search + connection), ~4 trains × 42 nights. */
export const RJ_FARE_REQUESTS_PER_RUN = 360;

/** The coming week is re-read first every night (planFareSearches' nearDays). */
export const RJ_FARE_NEAR_DAYS = 7;

const SPACING_MS = 800;

export const RJ_REQUEST_HEADERS = Object.freeze({
  Accept: "application/json",
  "X-Currency": "EUR",
  "X-Lang": "en",
  "User-Agent": HONEST_USER_AGENT,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildSearchUrl({ fromId, toId, date }) {
  const q = new URLSearchParams({
    departureDate: date,
    fromLocationId: String(fromId),
    fromLocationType: "STATION",
    toLocationId: String(toId),
    toLocationType: "STATION",
    tariffs: "REGULAR",
  });
  return `${RJ_API}/routes/search/simple?${q}`;
}

export function buildRouteUrl({ routeId, fromId, toId }) {
  const q = new URLSearchParams({ fromStationId: String(fromId), toStationId: String(toId), tariffs: "REGULAR" });
  return `${RJ_API}/routes/${encodeURIComponent(routeId)}/simple?${q}`;
}

export const SEAT_CLASSES_URL = `${RJ_API}/consts/seatClasses`;

/** "Lůžko" → "luzko": lower case, no diacritics. */
export function fold(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** The number of berths a place's name says its compartment has, or null. */
function berthsIn(text) {
  const m = text.match(/\b([1-6])\s*-?\s*(?:bed|berth|beds|berths|luz|loz|mist|persons?|osob|person|lit|places?)/);
  if (m) return Number(m[1]);
  const w = text.match(/\b(single|double|triple|one|two|three|four|six)\b[\s-]*(?:bed|berth|compartment|cabin|kupe)/);
  const words = { single: 1, one: 1, double: 2, two: 2, triple: 3, three: 3, four: 4, six: 6 };
  return w ? words[w[1]] : null;
}

/**
 * What a seat class sells, from its key and its title/description in any of
 * the languages the API answers in: `{ kind, classKey }`, where kind is
 * "couchette", "sleeper", "seat" or "excluded" (women-only) and classKey the
 * key our fare readers label (src/lib/fareClasses.mjs). Anything that names
 * neither a couchette nor a bed is a seat — the safe side, since a seat is
 * never quoted.
 */
export function classifySeatClass({ key = "", title = "", description = "" } = {}) {
  const text = fold(`${key} ${title} ${description}`).replace(/_/g, " ");
  if (/\b(ladies|lady|women|woman|female|damsk|dams|zensk|zena)/.test(text)) return { kind: "excluded", classKey: null };
  if (/couchette|lehatk|lehotk|lehatkov|liegewagen/.test(text)) {
    if (/private|whole compartment|cele kupe|family|rodinn/.test(text)) return { kind: "couchette", classKey: "privateCouchette" };
    const n = berthsIn(text);
    return { kind: "couchette", classKey: n === 6 ? "couchette6" : n === 4 ? "couchette4" : "couchette" };
  }
  if (/sleeper|sleeping|luzk|lozk|\bbed\b|schlaf|\blit\b/.test(text)) {
    const n = berthsIn(text);
    return { kind: "sleeper", classKey: n === 1 ? "sleeperSingle" : n === 2 ? "sleeperDouble" : n === 3 ? "sleeperTriple" : "sleeperBed" };
  }
  return { kind: "seat", classKey: null };
}

/** "2026-10-30T21:46:00.000+01:00" → { date: "2026-10-30", minutes: 1306 }, as written (the station's clock). */
export function wallClock(value) {
  const m = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  return m ? { date: m[1], minutes: Number(m[2]) * 60 + Number(m[3]), time: `${m[2]}:${m[3]}` } : null;
}

const PRAGUE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The same moment on Prague's clock, which is the clock RegioJet's GTFS is
 * written in (agency_timezone; no stop names another). Only Čop is outside
 * Central European time, and whether the API writes its departure on Kyiv's
 * clock or Prague's is not documented — so a connection is matched on either.
 */
export function pragueClock(value) {
  const ms = Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(value))) return null;
  const parts = Object.fromEntries(PRAGUE.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), time: `${parts.hour}:${parts.minute}` };
}

/** "21:46" → 1306. */
function clockMinutes(t) {
  const m = String(t ?? "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Our train among a day's connections: direct, by train, leaving on `date`
 * within `toleranceMinutes` of the feed's departure. Two candidates cannot be
 * told apart, so they count as none.
 * Throws (with `shape`) when the answer is not a route list.
 */
export function findTrainRoute(body, { date, departure, toleranceMinutes = 2 }) {
  if (!body || !Array.isArray(body.routes)) {
    const err = new Error(`search answer has no routes array (keys: ${Object.keys(body ?? {}).join(", ") || "none"})`);
    err.shape = true;
    throw err;
  }
  const want = clockMinutes(departure);
  const near = (c) => c && c.date === date && Math.abs(c.minutes - want) <= toleranceMinutes;
  const hits = body.routes.filter((r) => {
    if (want == null) return false;
    if (!near(wallClock(r?.departureTime)) && !near(pragueClock(r?.departureTime))) return false;
    if (Number.isFinite(r.transfersCount) && r.transfersCount > 0) return false;
    if (Array.isArray(r.vehicleTypes) && r.vehicleTypes.length && !r.vehicleTypes.includes("TRAIN")) return false;
    return true;
  });
  return { route: hits.length === 1 ? hits[0] : null, ambiguous: hits.length > 1, count: body.routes.length };
}

/**
 * A connection's prices, by kind of place: `{ classes, seat, offers, verdicts }`.
 * `classes` holds each berth class's cheapest bookable price, `seat` the
 * cheapest seat, `offers` which RegioJet seat class each figure is (so a
 * reader can find the same row on regiojet.com), `verdicts` every class seen
 * with what it was read as (for the log). Throws (with `shape`) when the
 * connection carries no `priceClasses`.
 */
export function berthClasses(detail, seatClassInfo = new Map()) {
  const list = detail?.priceClasses;
  if (!Array.isArray(list)) {
    const err = new Error(`connection has no priceClasses (keys: ${Object.keys(detail ?? {}).join(", ") || "none"})`);
    err.shape = true;
    throw err;
  }
  const classes = {};
  const offers = {};
  const verdicts = {};
  let seat = null;
  for (const pc of list) {
    const key = String(pc?.seatClassKey ?? pc?.seatClass ?? pc?.key ?? "");
    const price = Number(pc?.price ?? pc?.priceFrom);
    if (!key || !Number.isFinite(price) || price <= 0) continue;
    const info = seatClassInfo.get(key) ?? {};
    const { kind, classKey } = classifySeatClass({ key, title: info.title ?? pc.title ?? "", description: info.description ?? "" });
    verdicts[key] = classKey ?? kind;
    const soldOut = pc.bookable === false || (Number.isFinite(pc.freeSeatsCount) && pc.freeSeatsCount <= 0);
    if (soldOut) continue;
    if (kind === "seat") {
      if (seat == null || price < seat) seat = price;
      continue;
    }
    if (!classKey) continue;
    if (classes[classKey] == null || price < classes[classKey]) {
      classes[classKey] = price;
      offers[classKey] = key;
    }
  }
  return { classes, seat, offers, verdicts };
}

/** GET a JSON answer; throws with `blocked`, `status` or `shape` like fetchNjOffers. */
export async function fetchRjJson(url, { fetchImpl = fetchWithTimeout } = {}) {
  const res = await fetchImpl(url, { headers: { ...RJ_REQUEST_HEADERS } });
  const text = await res.text();
  const block = detectBlock({ status: res.status, headers: res.headers, body: text });
  if (block) {
    const err = new Error(`RegioJet ${describeBlock(block)}`);
    err.blocked = block;
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`not JSON (${text.length} bytes)`);
    err.body = text;
    err.shape = true;
    throw err;
  }
}

/** key → { title, description } from GET /consts/seatClasses (an array, or an object holding one). */
export function seatClassMap(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.seatClasses) ? body.seatClasses : [];
  const out = new Map();
  for (const c of list) {
    const key = c?.key ?? c?.seatClassKey;
    if (key) out.set(String(key), { title: c.title ?? c.name ?? "", description: c.description ?? "" });
  }
  return out;
}

/** The two ends a train is priced between: its first and last station's booking ids. */
export function pricingEnds(train) {
  const a = train?.stations?.[0];
  const b = train?.stations?.at?.(-1);
  if (!a?.code || !b?.code || !a.departure) return null;
  return { fromId: a.code, toId: b.code, departure: a.departure };
}

/**
 * Bring every train's calendar up to date within tonight's request budget and
 * set its headline fare to its cheapest night (cheapestNight). Never throws:
 * a refusal (detectBlock) stops the pass on the spot, five failures in a row
 * stop it too, a 4xx skips that train for the night and anything else costs
 * only its own night. What was filled before keeps, as do last run's nights.
 */
export async function fillRjFareCalendars(
  trains,
  previousTrains,
  {
    today,
    fetchImpl = fetchWithTimeout,
    log = console.log,
    days = FARE_CALENDAR_DAYS,
    requests = RJ_FARE_REQUESTS_PER_RUN,
    nearDays = RJ_FARE_NEAR_DAYS,
    spacingMs = SPACING_MS,
    maxConsecutiveErrors = 5,
  } = {},
) {
  const stats = { planned: 0, requests: 0, priced: 0, none: 0, errors: 0, ambiguous: 0, capped: false, stopped: false, blocked: null, unpriced: [] };
  const calendars = {};
  const ends = {};
  for (const [key, train] of Object.entries(trains ?? {})) {
    calendars[key] = pruneCalendar(previousTrains?.[key]?.fareCalendar ?? { currency: "EUR", nights: {} }, { today, days });
    calendars[key].currency = "EUR";
    const ep = pricingEnds(train);
    if (!ep) {
      stats.unpriced.push(key);
      continue;
    }
    ends[key] = ep;
  }
  if (stats.unpriced.length) log(`[rj-fare] no booking id or departure at an end, not priced: ${stats.unpriced.join(", ")}`);

  const call = async (url) => {
    stats.requests++;
    try {
      return await fetchRjJson(url, { fetchImpl });
    } finally {
      if (spacingMs) await sleep(spacingMs);
    }
  };

  let seatInfo = new Map();
  if (Object.keys(ends).length) {
    try {
      seatInfo = seatClassMap(await call(SEAT_CLASSES_URL));
    } catch (err) {
      if (err.blocked) {
        stats.blocked = err.blocked;
        stats.stopped = true;
        log(`[rj-fare] ${err.message} — no fare searches tonight; calendars keep last run's nights`);
      } else {
        log(`[rj-fare] seat classes: ${err.message} — classes read by key alone`);
      }
    }
  }

  const searchable = Object.fromEntries(Object.keys(ends).map((k) => [k, calendars[k]]));
  const plan = stats.blocked ? [] : planFareSearches(searchable, { today, days, nearDays, budget: Object.keys(searchable).length * days });
  stats.planned = plan.length;
  const broken = new Set();
  const verdicts = {};
  let consecutive = 0;

  for (const { key, date } of plan) {
    if (broken.has(key)) continue;
    if (stats.requests + 2 > requests) {
      stats.capped = true;
      break;
    }
    const ep = ends[key];
    try {
      const found = findTrainRoute(await call(buildSearchUrl({ fromId: ep.fromId, toId: ep.toId, date })), { date, departure: ep.departure });
      if (found.ambiguous) stats.ambiguous++;
      let entry;
      if (!found.route) {
        entry = { none: true, reason: "noJourney", checkedAt: today };
      } else {
        const read = berthClasses(await call(buildRouteUrl({ routeId: found.route.id, fromId: ep.fromId, toId: ep.toId })), seatInfo);
        Object.assign(verdicts, read.verdicts);
        const dep = wallClock(found.route.departureTime);
        const arr = wallClock(found.route.arrivalTime);
        entry = Object.keys(read.classes).length
          ? {
              classes: read.classes,
              ...(Number.isFinite(read.seat) ? { seat: read.seat } : {}),
              offers: read.offers,
              ...(dep ? { dep: `${dep.date}T${dep.time}` } : {}),
              ...(arr ? { arr: `${arr.date}T${arr.time}` } : {}),
              checkedAt: today,
            }
          : { none: true, reason: "noBerth", checkedAt: today };
      }
      calendars[key].nights[date] = entry;
      if (entry.none) stats.none++;
      else stats.priced++;
      consecutive = 0;
    } catch (err) {
      stats.errors++;
      if (err.blocked) {
        const { status, reason, vendor = null } = err.blocked;
        stats.blocked = { status, reason, vendor };
        stats.stopped = true;
        log(`[rj-fare] RegioJet refused automated requests (${reason}${vendor ? ` by ${vendor}` : ""}) at ${key} ${date} — stopping tonight's fare searches; calendars keep last run's nights`);
        break;
      }
      consecutive++;
      const night = !err.status || err.status >= 500 || err.shape;
      if (!night) broken.add(key);
      const body = err.body ? ` — ${String(err.body).replace(/\s+/g, " ").slice(0, 160)}` : "";
      log(`[rj-fare] RJ ${key} ${date}: ${err.message}${body} — ${night ? "skipping this night" : "skipping its other nights tonight"}`);
      if (consecutive >= maxConsecutiveErrors) {
        stats.stopped = true;
        log(`[rj-fare] ${consecutive} failures in a row — stopping tonight's fare searches`);
        break;
      }
    }
  }

  const seen = Object.entries(verdicts);
  if (seen.length) {
    const title = (k) => seatInfo.get(k)?.title;
    log(`[rj-fare] seat classes read: ${seen.map(([k, v]) => `${k}${title(k) ? ` "${title(k)}"` : ""} → ${v}`).join("; ")}`);
  }
  for (const [key, train] of Object.entries(trains ?? {})) {
    const cal = calendars[key];
    cal.nights = Object.fromEntries(Object.entries(cal.nights).sort(([a], [b]) => (a < b ? -1 : 1)));
    const entries = Object.values(cal.nights);
    if (entries.length) train.fareCalendar = cal;
    const fare = cheapestNight(cal);
    if (fare) train.fare = fare;
    if (entries.length) {
      const priced = entries.filter((e) => !e.none).length;
      log(`[rj-fare] RJ ${key}: ${priced}/${entries.length} night(s) priced${fare ? `, cheapest €${fare.fromPrice} (${fare.seatClass}) on ${fare.travelDate}` : ""}`);
    }
  }
  log(
    `[rj-fare] ${stats.requests} request(s): ${stats.priced} night(s) priced, ${stats.none} without a fare, ${stats.errors} error(s)` +
      (stats.ambiguous ? `, ${stats.ambiguous} search(es) with two candidate trains` : "") +
      (stats.capped ? ` — budget of ${requests} reached` : ""),
  );
  return stats;
}

