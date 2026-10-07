// scripts/lib/nj-fares.mjs
// ÖBB Nightjet / EuroNight fares from nightjet.com: every night of the next six
// weeks for each train, in the calendar shape the Intercity Notte and European
// Sleeper calendars already use (./fare-calendar.mjs), so stampOfficialFares,
// the map panel and the connection page's FareCalendar read it unchanged:
//   { version, currency: "EUR", nights: { "2026-10-20": {
//       classes: { couchette: 59.9, sleeperBed: 99.9 }, checkedAt }
//     | { none: true, checkedAt } } }
// The offer each figure is (Sparschiene, Komfortticket…) goes to the scrape
// log, not the file: the browser fetches this file whole for the map panel,
// and 73 trains × 42 nights of repeated offer names would be most of it.
//
// The source is the "Train Price Search" behind nightjet.com's own destination
// pages: GET /nj-booking-ocp/destinations/offers/{train}/{from}/{to}/{ms}
// ?forward=true&max=3 answers, for one train between two stations, its next
// (up to) three journeys from a moment on, each with the cheapest offer per
// comfort class — bestOffers.le (couchette), .be (sleeping car), .se (seat).
// It is the same /destinations family the nightly timetable scrape already
// reads, and it needs no token. The booking flow's /connection search is NOT
// used: it now sits behind a proof-of-work captcha (which is why the weekly
// probe's calls to it answered 400 every Monday), and solving an operator's
// anti-bot challenge is not something this map does.
//
// Request and answer shapes follow the reverse-engineered OpenAPI notes at
// martinlangbecker/night-train-apis (nightjet-api.yaml, "Train Price Search")
// and two open-source crawlers that read the same endpoint; the dev sandbox
// cannot reach nightjet.com, so the reader is strict about what it accepts and
// a `run-probes` / `refresh-data` run on the PR shows the live answer.
//
// Only what a standard adult can sleep in is priced: couchette and sleeper,
// one person's place each (the endpoint prices one adult). Seats are read only
// to be left out, and a night selling nothing but seats has no fare. The
// endpoint's cheapest couchette can be a place in a ladies-only compartment
// (nightjet.com prices them the same as mixed ones), which it does not say.

import { fetchWithTimeout } from "./scrape-helpers.mjs";
import {
  calendarWindow,
  cheapestNight,
  FARE_CALENDAR_DAYS,
  planFareSearches,
  pruneCalendar,
} from "./fare-calendar.mjs";

export const NJ_BOOKING_BASE = "https://www.nightjet.com/nj-booking-ocp";

/** The endpoint answers at most three journeys per call (`max` 1–3). */
export const NJ_OFFERS_PER_REQUEST = 3;

/**
 * Requests per run. A daily train needs ~14 for six weeks (three nights each),
 * a train not running in the window one, so the ~73 trains take ~750 for a
 * full calendar: it fills over two nights and stays fresh after. At the
 * spacing below that is about seven minutes a night.
 */
export const NJ_FARE_REQUESTS_PER_RUN = 360;

// Courtesy spacing between calls to an API that owes us nothing — the same
// figure the weekly probe used.
const SPACING_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every Nightjet/EuroNight origin keeps Central European time, as Vienna does. */
export const NJ_TIME_ZONE = "Europe/Vienna";

/** bestOffers key → our berth class. `se` (seat) is deliberately absent. */
export const NJ_CLASS_BY_OFFER = { le: "couchette", be: "sleeperBed" };

const EVA = /^\d{7}$/;

const VIENNA = new Intl.DateTimeFormat("en-CA", {
  timeZone: NJ_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function viennaFields(ms) {
  return Object.fromEntries(VIENNA.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** Vienna's UTC offset at an instant, in ms (+1 h in winter, +2 h in summer). */
function viennaOffsetMs(ms) {
  const f = viennaFields(ms);
  const local = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/** Midnight at the start of a calendar date in Vienna, as epoch ms. */
export function viennaMidnightMs(isoDate) {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  // Twice, so a date the clocks change on uses the offset in force at midnight.
  const first = base - viennaOffsetMs(base);
  return base - viennaOffsetMs(first);
}

/**
 * The calendar date a departure falls on in Vienna ("2026-10-20"), from an ISO
 * string with or without an offset, epoch ms, or a { utc, local } pair (the
 * shape nightjet.com's /connection answers use). null when unreadable.
 */
export function viennaDate(value) {
  if (value && typeof value === "object") value = value.utc ?? value.local ?? null;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  const f = viennaFields(ms);
  return `${f.year}-${f.month}-${f.day}`;
}

/**
 * The journey to price: the train's own two ends, by the 7-digit station ids
 * the timetable scrape stores. One substitution, and only one: a terminus whose
 * name is its neighbour's plus a qualifier — "Wien Hbf (Autoreisezuganlage)",
 * the car-train loading terminal, beside "Wien Hbf" ten minutes away — is
 * priced from/to the plain station, where travellers board. "Berlin Hbf (tief)"
 * stays: its neighbour is Berlin Südkreuz. null when an end has no usable id.
 */
export function pricingEnds(train) {
  const stations = (train?.stations ?? []).filter((s) => s?.name);
  if (stations.length < 2) return null;
  const end = (i, step) => {
    const s = stations[i];
    const plain = s.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const next = stations[i + step];
    if (plain !== s.name && next?.name === plain && EVA.test(String(next.id ?? ""))) {
      return { station: next, substituted: true };
    }
    return { station: s, substituted: false };
  };
  const from = end(0, 1);
  const to = end(stations.length - 1, -1);
  const fromId = String(from.station.id ?? "");
  const toId = String(to.station.id ?? "");
  if (!EVA.test(fromId) || !EVA.test(toId) || fromId === toId) return null;
  return {
    fromId,
    toId,
    from: from.station.name,
    to: to.station.name,
    substituted: from.substituted || to.substituted,
  };
}

/** The URL for one train's next journeys from the start of `date` (Vienna). */
export function buildOffersUrl({ trainName, fromId, toId, date, max = NJ_OFFERS_PER_REQUEST }) {
  const ms = viennaMidnightMs(date);
  return (
    `${NJ_BOOKING_BASE}/destinations/offers/${encodeURIComponent(trainName)}/${fromId}/${toId}/${ms}` +
    `?forward=true&max=${max}`
  );
}

function parsePrice(value) {
  const n = typeof value === "string" ? Number(value.replace(",", ".").replace(/[^\d.]/g, "")) : value;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * One journey's berth fares from its bestOffers: { classes, offerNames, seen }.
 * `seen` lists every comfort-class key the answer carried, seats included, and
 * `offerNames` the offers the berth figures are, so the log can say what was
 * priced and what was left out rather than leave it to be guessed.
 */
export function berthClasses(bestOffers) {
  const classes = {};
  const offerNames = [];
  const seen = [];
  if (!bestOffers || typeof bestOffers !== "object") return { classes, offerNames, seen };
  for (const [key, offer] of Object.entries(bestOffers)) {
    seen.push(key);
    const cls = NJ_CLASS_BY_OFFER[key.toLowerCase()];
    const price = parsePrice(offer?.price);
    if (!cls || price == null) continue;
    if (classes[cls] == null || price < classes[cls]) classes[cls] = price;
    if (offer?.name) offerNames.push(String(offer.name));
  }
  return { classes, offerNames, seen };
}

function describe(body) {
  if (body === null) return "null";
  if (Array.isArray(body)) return `[${body.length} items]`;
  if (typeof body === "object") return `{ ${Object.keys(body).slice(0, 8).join(", ")} }`;
  return typeof body;
}

/**
 * The nights one answer prices: { nights: { date: { classes } }, dates, rows,
 * unreadable, seen, offerNames }. A list of journeys is what the endpoint
 * answers; a single journey object is accepted too. Anything else throws —
 * an error page is not "no train".
 */
export function journeysFromOffers(body) {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && body.bestOffers
      ? [body]
      : null;
  if (!rows) {
    const err = new Error(`unexpected answer ${describe(body)}`);
    err.shape = true;
    throw err;
  }
  const nights = {};
  const seen = new Set();
  const offerNames = new Set();
  let unreadable = 0;
  for (const row of rows) {
    const date = row && typeof row === "object" ? viennaDate(row.departure) : null;
    if (!date) {
      unreadable++;
      continue;
    }
    const { classes, offerNames: names, seen: keys } = berthClasses(row.bestOffers);
    for (const k of keys) seen.add(k);
    for (const name of names) offerNames.add(name);
    const night = (nights[date] ??= { classes: {} });
    for (const [cls, amount] of Object.entries(classes)) {
      if (night.classes[cls] == null || amount < night.classes[cls]) night.classes[cls] = amount;
    }
  }
  return {
    nights,
    dates: Object.keys(nights).sort(),
    rows: rows.length,
    unreadable,
    seen: [...seen].sort(),
    offerNames: [...offerNames].sort(),
  };
}

/**
 * What one answer, asked from the start of `from`, proves about the calendar's
 * nights. A night it returns is priced (or `none` when it sells no berth). A
 * night it skips before the last journey it returns has no train — the search
 * runs forward, so it would have come first. An answer with no journey from
 * `from` on means nothing is on sale from then on. Nights after the last
 * journey returned are left for the next request, which starts there.
 */
export function nightsProven(answer, { from, today, days = FARE_CALENDAR_DAYS }) {
  const returned = answer.dates.filter((d) => d >= from);
  const last = returned.length ? returned[returned.length - 1] : null;
  const out = {};
  for (const date of calendarWindow(today, days)) {
    const night = answer.nights[date];
    if (night) {
      out[date] = Object.keys(night.classes).length
        ? { classes: { ...night.classes }, checkedAt: today }
        : { none: true, checkedAt: today };
    } else if (date >= from && (!last || date < last)) {
      out[date] = { none: true, checkedAt: today };
    }
  }
  return out;
}

/**
 * Ask nightjet.com for one train's next journeys from the start of `date`.
 * Resolves the parsed answer (journeysFromOffers); throws with `status` and
 * `body` on an HTTP error, with `shape` when the answer is not a journey list.
 */
export async function fetchNjOffers({ trainName, fromId, toId, date }, { fetchImpl = fetchWithTimeout } = {}) {
  const url = buildOffersUrl({ trainName, fromId, toId, date });
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const err = new Error(`not JSON (${text.length} bytes)`);
    err.body = text;
    err.shape = true;
    throw err;
  }
  return journeysFromOffers(body);
}

/**
 * Bring every train's calendar up to date within tonight's request budget and
 * set its headline fare to its cheapest night. Never throws: a train whose
 * request is refused is skipped for the night (another date will not fix a
 * station the operator does not sell), a server error costs only its night
 * after one retry, and a run of failures stops the pass — that is the
 * operator turning us away, and hammering on would only make it worse.
 *
 * @param {object} trains          tonight's trains, keyed by "NJ 40491"
 * @param {object|null} previousTrains last night's file, for the calendars
 */
export async function fillNjFareCalendars(
  trains,
  previousTrains,
  {
    today,
    fetchImpl = fetchWithTimeout,
    log = console.log,
    days = FARE_CALENDAR_DAYS,
    requests = NJ_FARE_REQUESTS_PER_RUN,
    spacingMs = SPACING_MS,
    maxConsecutiveErrors = 5,
    retryDelayMs = 3000,
  } = {},
) {
  const stats = {
    planned: 0, requests: 0, retries: 0, priced: 0, none: 0, errors: 0,
    capped: false, stopped: false, unpriced: [], substituted: [],
  };
  const calendars = {};
  const ends = {};
  for (const [key, train] of Object.entries(trains ?? {})) {
    const previous = previousTrains?.[key]?.fareCalendar ?? { currency: "EUR", nights: {} };
    calendars[key] = pruneCalendar(previous, { today, days });
    calendars[key].currency = "EUR";
    const ep = pricingEnds(train);
    if (!ep) {
      stats.unpriced.push(key);
      log(`[nj-fare] ${key}: no 7-digit station id at one end — not priced`);
      continue;
    }
    ends[key] = ep;
    if (ep.substituted) stats.substituted.push(`${key}: ${ep.from} → ${ep.to}`);
  }
  if (stats.substituted.length) {
    log(`[nj-fare] priced from/to the passenger station beside a car-train terminal: ${stats.substituted.join("; ")}`);
  }

  const searchable = Object.fromEntries(Object.keys(ends).map((k) => [k, calendars[k]]));
  const plan = planFareSearches(searchable, {
    today,
    days,
    budget: Object.keys(searchable).length * days,
  });
  stats.planned = plan.length;

  const broken = new Set();
  const noted = new Set();
  const offerKeys = new Set();
  const offerNames = new Set();
  let unreadable = 0;
  let consecutiveErrors = 0;
  const windowEnd = calendarWindow(today, days).at(-1);
  // A server error or a dropped connection says nothing about the train: one
  // retry, then it costs only its own night. A 4xx is about the request.
  const transient = (err) => !err?.shape && (!err?.status || err.status >= 500 || err.status === 429);

  for (const { key, date } of plan) {
    if (broken.has(key)) continue;
    // An earlier answer tonight already covered this night.
    if (calendars[key].nights[date]?.checkedAt === today) continue;
    if (stats.requests >= requests) {
      stats.capped = true;
      break;
    }
    const ep = ends[key];
    const ask = async () => {
      stats.requests++;
      try {
        return await fetchNjOffers({ trainName: key, fromId: ep.fromId, toId: ep.toId, date }, { fetchImpl });
      } finally {
        if (spacingMs) await sleep(spacingMs);
      }
    };
    try {
      let answer;
      try {
        answer = await ask();
      } catch (err) {
        if (!transient(err) || !retryDelayMs || stats.requests >= requests) throw err;
        stats.retries++;
        await sleep(retryDelayMs);
        answer = await ask();
      }
      // Journeys, but all before the night asked about: the search did not
      // read the moment as assumed. Not "nothing on sale" — inferring that
      // would blank the rest of the calendar — so the train waits a night.
      if (answer.dates.length && !answer.dates.some((d) => d >= date)) {
        const err = new Error(`answered only journeys before ${date} (${answer.dates.join(", ")})`);
        err.shape = true;
        throw err;
      }
      consecutiveErrors = 0;
      for (const k of answer.seen) offerKeys.add(k);
      for (const name of answer.offerNames) offerNames.add(name);
      unreadable += answer.unreadable;
      const proven = nightsProven(answer, { from: date, today, days });
      for (const [d, entry] of Object.entries(proven)) {
        calendars[key].nights[d] = entry;
        if (entry.none) stats.none++;
        else stats.priced++;
      }
      // Once per train: the answers that turn a whole stretch into "no train".
      const returned = answer.dates.filter((d) => d >= date);
      if (!returned.length && !noted.has(key)) {
        noted.add(key);
        log(`[nj-fare] ${key}: nothing on sale from ${date} on — its nights to ${windowEnd} have no fare`);
      } else if (returned.length && returned[0] > windowEnd && !noted.has(key)) {
        noted.add(key);
        log(`[nj-fare] ${key}: next journey on sale is ${returned[0]}, past the calendar's ${windowEnd}`);
      }
    } catch (err) {
      stats.errors++;
      consecutiveErrors++;
      const night = transient(err);
      if (!night) broken.add(key);
      const body = err.body ? ` — ${String(err.body).replace(/\s+/g, " ").slice(0, 160)}` : "";
      log(
        `[nj-fare] ${key} ${date}: ${err.message}${body} — ` +
          (night ? "skipping this night (last run's entry kept)" : "skipping its other nights tonight"),
      );
      if (consecutiveErrors >= maxConsecutiveErrors) {
        stats.stopped = true;
        log(`[nj-fare] ${consecutiveErrors} failures in a row — stopping tonight's fare searches`);
        break;
      }
    }
  }

  if (offerKeys.size) {
    const kept = [...offerKeys].filter((k) => NJ_CLASS_BY_OFFER[k.toLowerCase()]);
    const dropped = [...offerKeys].filter((k) => !NJ_CLASS_BY_OFFER[k.toLowerCase()]);
    log(`[nj-fare] comfort classes priced: ${kept.join(", ") || "none"}; left out: ${dropped.join(", ") || "none"}`);
  }
  if (offerNames.size) log(`[nj-fare] berth offers quoted: ${[...offerNames].join(", ")}`);
  if (unreadable) log(`[nj-fare] ${unreadable} journey(s) without a readable departure were skipped`);

  for (const [key, train] of Object.entries(trains ?? {})) {
    const cal = calendars[key];
    cal.nights = Object.fromEntries(Object.entries(cal.nights).sort(([a], [b]) => (a < b ? -1 : 1)));
    const entries = Object.values(cal.nights);
    if (entries.length) train.fareCalendar = cal;
    const fare = cheapestNight(cal);
    if (fare) train.fare = fare;
    if (entries.length) {
      const priced = entries.filter((e) => !e.none).length;
      log(
        `[nj-fare] ${key}: ${priced}/${entries.length} night(s) priced` +
          (fare ? `, cheapest €${fare.fromPrice} (${fare.seatClass}) on ${fare.travelDate}` : ""),
      );
    }
  }
  return stats;
}
