// scripts/lib/nj-fares.mjs
// ÖBB Nightjet / EuroNight fares from nightjet.com: every night of the next six
// weeks for each train, in the calendar shape the Intercity Notte and European
// Sleeper calendars already use (./fare-calendar.mjs), so stampOfficialFares,
// the map panel and the connection page's FareCalendar read it unchanged:
//   { version, currency: "EUR", journey, nights: {
//       "2026-10-20": { classes: { couchette: 59.9, sleeperBed: 99.9 },
//         checkedAt, dep, arr, seat: 29.9,
//         offers: { couchette: "Sparschiene", sleeperBed: "Komfortticket" } }
//     | { none: true, checkedAt, reason: "noBerth" | "noJourney", seat } } }
// Beside the prices each night keeps what a reader needs to check them:
// `seat`, that night's cheapest seated-coach fare, so "is this couchette
// really a seat price?" is answered by the file (a berth is a ticket plus a
// berth supplement, so it should cost more than the seat); `offers`, the ÖBB
// product each figure is ("Sparschiene", without the "inkl. Reservierung"
// every berth offer carries), which is the row to compare in ÖBB's shop; and,
// on a night without a fare, whether a journey ran without a berth on sale
// (`noBerth`) or there was no journey at all (`noJourney`). `seat` sits
// outside `classes` on purpose: every reader of a price (cheapestClass,
// cheapestNight, fareClassRows, stampOfficialFares) reads `classes` alone, so
// the seat is never quoted as a fare. None of it reaches the map panel's
// fetch, which serves the trains file without its calendars (servedTrainsData
// in src/pages/api/lib/operator-trains-handler.mjs).
//
// The source is the "Train Price Search" behind nightjet.com's own destination
// pages: GET /nj-booking-ocp/destinations/offers/{train}/{from}/{to}/{ms}
// ?forward=true&max=3 answers, for one train between two stations, its next
// journey from a moment on with the cheapest offer per comfort class —
// bestOffers.le (couchette), .be (sleeping car), .se (seat). The notes promise
// up to three journeys per call; the first live run (2026-10-07, 360 calls)
// got one every time, so the budget assumes one and the reader takes any.
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
// to check the berths against and are otherwise left out, and a night selling
// nothing but seats has no fare. The endpoint's cheapest couchette can be a
// place in a ladies-only compartment (nightjet.com prices them the same as
// mixed ones), which it does not say.
//
// Every request says who is asking (HONEST_USER_AGENT), and a refusal — a
// WAF's 403, a 429, a challenge page where JSON was asked for — stops the
// whole pass on the spot (./http-block.mjs). This map never works around an
// operator's bot protection, so a block is final for the night: no retry, no
// next train; the calendars keep last run's nights and what tonight already
// filled.

import { fetchWithTimeout } from "./scrape-helpers.mjs";
import { describeBlock, detectBlock, HONEST_USER_AGENT } from "./http-block.mjs";
import {
  calendarWindow,
  cheapestNight,
  FARE_CALENDAR_DAYS,
  planFareSearches,
  pruneCalendar,
} from "./fare-calendar.mjs";

export const NJ_BOOKING_BASE = "https://www.nightjet.com/nj-booking-ocp";

/**
 * What `max` asks for: the notes allow 1–3. On the first live run every
 * answer to max=3 held one journey (`npm run probe-nj-fares` prints what each
 * value returns), so this is a ceiling the reader never relies on.
 */
export const NJ_OFFERS_PER_REQUEST = 3;

/**
 * Requests per run. One answer is one night (see above), so a daily train
 * needs ~42 for six weeks and a train not running in the window one: the ~73
 * trains take ~2 100 for a full calendar, filled over three nights and
 * refreshed every three after — inside the fourteen days a night's price is
 * kept. At the spacing below that is twelve minutes a night.
 */
export const NJ_FARE_REQUESTS_PER_RUN = 720;

/**
 * Nights ahead refreshed before anything else (planFareSearches' `nearDays`):
 * the coming week, the nights a traveller is most likely to book. Overridable
 * from the registry's params.fares.nearDays.
 */
export const NJ_FARE_NEAR_DAYS = 7;

/**
 * Whether nightjet.com's price search may price a train: ÖBB's own Nightjets
 * only. A partner EuroNight (nightjet.com's `partnerTrain`, stored as
 * operator "EuroNight") belongs to its carrier — PKP, MÁV, ČD, HŽPP — whose
 * own site sells it at its own fares, and the figure nightjet.com quotes for
 * one is not that fare: the owner found it reading like a seat price, and on
 * PKP's EN 40416/40407 a "sleeper" came out cheaper than a "couchette". So
 * they get no calendar, no headline fare and no weekly probe proposal, and
 * their pages send the reader to the carrier (agency_id, scripts/adapters/
 * nightjet.mjs). Keyed on the partner flag, never on an "EN " prefix.
 * @param {{ operator?: string }|null|undefined} train
 */
export function njPricesTrain(train) {
  return Boolean(train) && train.operator !== "EuroNight";
}

/** What every request to the price search sends: JSON, and who is asking. */
export const NJ_REQUEST_HEADERS = Object.freeze({
  accept: "application/json",
  "user-agent": HONEST_USER_AGENT,
});

// Courtesy spacing between calls to an API that owes us nothing. Each call is
// one page view's worth of nightjet.com's own price search.
const SPACING_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every Nightjet/EuroNight origin keeps Central European time, as Vienna does. */
export const NJ_TIME_ZONE = "Europe/Vienna";

/** bestOffers key → our berth class. `se` (seat) is deliberately absent. */
export const NJ_CLASS_BY_OFFER = { le: "couchette", be: "sleeperBed" };

/** The bestOffers key of the seated coach: kept beside a night, never a class. */
export const NJ_SEAT_OFFER = "se";

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
 *
 * Only ISO date-times are parsed, never whatever Date.parse will take: it reads
 * "08.10.2026" as 10 August, so a departure format nightjet.com changed to the
 * European order would price the wrong nights instead of failing.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function instantMs(value) {
  if (value && typeof value === "object") value = value.utc ?? value.local ?? null;
  return typeof value === "number"
    ? value
    : typeof value === "string" && ISO_DATE_TIME.test(value)
      ? Date.parse(value)
      : NaN;
}

export function viennaDate(value) {
  const ms = instantMs(value);
  if (!Number.isFinite(ms)) return null;
  const f = viennaFields(ms);
  return `${f.year}-${f.month}-${f.day}`;
}

/**
 * The same instant as Vienna wall-clock time, "2026-10-20T19:08" — the shape
 * ÖBB's shop takes a connection's departure and arrival in. null when
 * unreadable (the same strict reading as viennaDate).
 */
export function viennaDateTime(value) {
  const ms = instantMs(value);
  if (!Number.isFinite(ms)) return null;
  const f = viennaFields(ms);
  return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}`;
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

/**
 * The journey a calendar prices, the way ÖBB's ticket shop addresses it: both
 * ends by id and by ÖBB's own name (the trains file keeps nightjet.com's
 * spellings — "Brüssel Midi", "Przemysl Gl." — where the rows carry
 * Back-on-Track's). The ends are pricingEnds' (the car-train terminal swapped
 * for the station beside it), so the Book link opens exactly the journey the
 * calendar's prices are for. null when an end has no id.
 *
 * The clocks are not here, deliberately: each night's departure and arrival
 * ride on the night itself (`dep` / `arr`, from that night's own answer), since
 * engineering works and timetable changes move a train's times under the same
 * number — replayed over the summer's nightly files, one run's clock was 15
 * minutes or more off on about one night in six.
 *
 * ÖBB's own timetable (Scotty / HAFAS, "Tickets") hands off to the shop with
 * connectionDatetimeDeparture, connectionDatetimeArrival, connectionOrigEva and
 * connectionDestEva — what operator-booking.json's ÖBB journeyUrlTemplate
 * fills (src/lib/operatorBooking.js).
 */
export function pricedJourney(train) {
  const ends = pricingEnds(train);
  if (!ends) return null;
  return { fromId: ends.fromId, toId: ends.toId, from: ends.from, to: ends.to };
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
 * The ÖBB product an offer is, as a traveller finds it in the shop:
 * "Sparschiene inkl. Reservierung" → "Sparschiene". Every berth offer read so
 * far carries that suffix (the place is the reservation), so it tells one
 * product from another not at all. null when the answer named none.
 */
export function offerProduct(name) {
  if (typeof name !== "string") return null;
  const product = name.replace(/\s*inkl\.\s*Reservierung\s*$/i, "").trim();
  return product || null;
}

/**
 * One journey's fares from its bestOffers: { classes, offers, seat,
 * offerNames, seen }. `classes` are the berths; `offers` the product each of
 * those figures is (offerProduct); `seat` the seated coach's price, kept only
 * to check the berths against (null when the answer had none). `seen` lists
 * every comfort-class key the answer carried, seats included, and `offerNames`
 * the offers the berth figures are, so the log can say what was priced and
 * what was left out rather than leave it to be guessed.
 */
export function berthClasses(bestOffers) {
  const classes = {};
  const offers = {};
  const offerNames = [];
  const seen = [];
  let seat = null;
  if (!bestOffers || typeof bestOffers !== "object") return { classes, offers, seat, offerNames, seen };
  for (const [key, offer] of Object.entries(bestOffers)) {
    seen.push(key);
    const price = parsePrice(offer?.price);
    if (key.toLowerCase() === NJ_SEAT_OFFER) {
      if (price != null && (seat == null || price < seat)) seat = price;
      continue;
    }
    const cls = NJ_CLASS_BY_OFFER[key.toLowerCase()];
    if (!cls || price == null) continue;
    if (classes[cls] == null || price < classes[cls]) {
      classes[cls] = price;
      // The product follows the figure it names.
      const product = offerProduct(offer?.name);
      if (product) offers[cls] = product;
      else delete offers[cls];
    }
    if (offer?.name) offerNames.push(String(offer.name));
  }
  return { classes, offers, seat, offerNames, seen };
}

function describe(body) {
  if (body === null) return "null";
  if (Array.isArray(body)) return `[${body.length} items]`;
  if (typeof body === "object") return `{ ${Object.keys(body).slice(0, 8).join(", ")} }`;
  return typeof body;
}

/**
 * The nights one answer prices: { nights: { date: { classes, offers?, seat?,
 * dep?, arr? } }, dates, rows, unreadable, seen, offerNames }. A list of
 * journeys is what the endpoint answers; a single journey object is accepted
 * too. Anything else throws — an error page is not "no train".
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
    const { classes, offers, seat, offerNames: names, seen: keys } = berthClasses(row.bestOffers);
    for (const k of keys) seen.add(k);
    for (const name of names) offerNames.add(name);
    const night = (nights[date] ??= { classes: {} });
    if (seat != null && (night.seat == null || seat < night.seat)) night.seat = seat;
    // That night's own departure and arrival at the priced ends, for the Book
    // link (the first journey of the night when an answer holds two).
    if (!night.dep) {
      const dep = viennaDateTime(row.departure);
      const arr = viennaDateTime(row.arrival);
      if (dep && arr && arr > dep) Object.assign(night, { dep, arr });
    }
    for (const [cls, amount] of Object.entries(classes)) {
      if (night.classes[cls] == null || amount < night.classes[cls]) {
        night.classes[cls] = amount;
        if (offers[cls]) (night.offers ??= {})[cls] = offers[cls];
        else if (night.offers) delete night.offers[cls];
      }
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
 * nights. A night it returns is priced, or `none` with reason "noBerth" when
 * its journey sells no berth. A night it skips before the last journey it
 * returns has no train ("noJourney") — the search runs forward, so it would
 * have come first. An answer with no journey from `from` on means nothing is
 * on sale from then on — but only as far as the calendar does not know
 * better: a night `held` already prices keeps its price until a request about
 * that night itself answers, since one empty answer about a daily train is
 * likelier a hiccup than a timetable (EN 40417, 10 October 2026: one empty
 * answer turned 37 priced nights, 16 of them read that same day, into "no
 * train" while the return train priced every night). The night asked about
 * is the answer's own and is always written. Nights after the last journey
 * returned are left for the next request, which starts there. A night's seat
 * price rides along wherever the answer gave one, priced or not.
 */
export function nightsProven(answer, { from, today, days = FARE_CALENDAR_DAYS, held = null }) {
  const returned = answer.dates.filter((d) => d >= from);
  const last = returned.length ? returned[returned.length - 1] : null;
  const out = {};
  for (const date of calendarWindow(today, days)) {
    const night = answer.nights[date];
    if (night) {
      const seat = night.seat != null ? { seat: night.seat } : {};
      if (!Object.keys(night.classes).length) {
        out[date] = { none: true, checkedAt: today, reason: "noBerth", ...seat };
        continue;
      }
      const offers = Object.keys(night.offers ?? {}).length ? { offers: { ...night.offers } } : {};
      out[date] = {
        classes: { ...night.classes },
        checkedAt: today,
        ...(night.dep ? { dep: night.dep, arr: night.arr } : {}),
        ...seat,
        ...offers,
      };
    } else if (date >= from && (!last || date < last)) {
      const priced = held?.[date] && !held[date].none;
      if (!last && date > from && priced) continue;
      out[date] = { none: true, checkedAt: today, reason: "noJourney" };
    }
  }
  return out;
}

/**
 * The berth classes a priced night sells at or below that night's own seat
 * price, as [class, amount] pairs; empty when there is no seat price to
 * compare. A berth is a ticket plus a berth supplement, so one that costs no
 * more than the seat is a figure that may not be what it claims to be — the
 * "is this couchette a seat price?" question, asked of every night read.
 */
export function berthsAtOrBelowSeat(entry) {
  if (!entry || entry.none || !Number.isFinite(entry.seat)) return [];
  return Object.entries(entry.classes ?? {}).filter(
    ([, amount]) => Number.isFinite(amount) && amount <= entry.seat,
  );
}

/**
 * Ask nightjet.com for one train's next journeys from the start of `date`.
 * Resolves the parsed answer (journeysFromOffers); throws with `blocked` (the
 * detectBlock verdict) when the host refused an automated client, with
 * `status` and `body` on any other HTTP error, and with `shape` when the
 * answer is not a journey list.
 */
export async function fetchNjOffers({ trainName, fromId, toId, date }, { fetchImpl = fetchWithTimeout } = {}) {
  const url = buildOffersUrl({ trainName, fromId, toId, date });
  const res = await fetchImpl(url, { headers: { ...NJ_REQUEST_HEADERS } });
  const text = await res.text();
  // Every answer is read for a refusal first: a challenge page can come with
  // any status, 200 included, and must stop the pass rather than read as a
  // shape error that costs one train.
  const block = detectBlock({ status: res.status, headers: res.headers, body: text });
  if (block) {
    const err = new Error(`nightjet.com ${describeBlock(block)}`);
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
 * operator turning us away, and hammering on would only make it worse. A
 * block (detectBlock: a WAF's 403, a 429, a challenge page) is that said
 * outright, so it stops the pass at once — no retry, no next train — and is
 * reported in `stats.blocked` ({ status, reason, vendor }). Whatever was
 * filled before it is kept, as are last run's nights.
 *
 * The coming `nearDays` nights are refreshed before anything else
 * (planFareSearches), and every night priced tonight is checked against its
 * own seat price (berthsAtOrBelowSeat): one that fails is kept as read,
 * counted in `stats.suspect`, and named in the log.
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
    nearDays = NJ_FARE_NEAR_DAYS,
    spacingMs = SPACING_MS,
    maxConsecutiveErrors = 5,
    retryDelayMs = 3000,
  } = {},
) {
  const stats = {
    planned: 0, requests: 0, retries: 0, priced: 0, none: 0, errors: 0,
    capped: false, stopped: false, blocked: null, unpriced: [], substituted: [],
    seatCompared: 0, suspect: 0, suspects: [],
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
    nearDays,
    budget: Object.keys(searchable).length * days,
  });
  stats.planned = plan.length;

  const broken = new Set();
  const noted = new Set();
  // Every night written tonight, per train. The tallies, the per-train log
  // line and the seat check are read off these entries, so the log describes
  // exactly what the file now says — including why a night has no fare, which
  // the entry itself carries (`reason`).
  const writtenTonight = new Map();
  const offerKeys = new Set();
  const offerNames = new Set();
  let consecutiveErrors = 0;
  const windowEnd = calendarWindow(today, days).at(-1);
  // A server error or a dropped connection says nothing about the train: one
  // retry, then it costs only its own night. A 4xx is about the request. A
  // block (a 429 included) is neither: it is the host saying stop.
  const transient = (err) => !err?.blocked && !err?.shape && (!err?.status || err.status >= 500);

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
      // A journey whose departure cannot be read is not "no journey": with one
      // journey per answer it would read exactly like an empty one, and
      // nightsProven would blank the rest of the window. A changed departure
      // format must cost a night's fares, loudly, not the calendar.
      if (answer.unreadable) {
        const err = new Error(`${answer.unreadable} of ${answer.rows} journey(s) without a readable departure`);
        err.shape = true;
        throw err;
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
      const proven = nightsProven(answer, { from: date, today, days, held: calendars[key].nights });
      const written = writtenTonight.get(key) ?? {};
      writtenTonight.set(key, written);
      for (const [d, entry] of Object.entries(proven)) {
        // What an answer infers about a night never overwrites what another
        // answer tonight said about it directly.
        if (written[d] && !answer.nights[d]) continue;
        calendars[key].nights[d] = entry;
        written[d] = entry;
      }
      // Once per train: the answers that turn a whole stretch into "no train".
      const returned = answer.dates.filter((d) => d >= date);
      if (!returned.length && !noted.has(key)) {
        noted.add(key);
        const kept = Object.entries(calendars[key].nights)
          .filter(([d, e]) => d > date && !e.none).length;
        log(
          `[nj-fare] ${key}: nothing on sale from ${date} on — its nights to ${windowEnd} have no fare` +
            (kept ? `, except ${kept} priced on an earlier run, kept until asked again` : ""),
        );
      } else if (
        returned.length &&
        returned[0] > windowEnd &&
        !noted.has(key) &&
        // A train with nothing in the window at all (NJ 235 starts with the
        // December timetable), not a running one whose last request asked
        // about the window's final night and was answered with the next.
        !Object.values(calendars[key].nights).some((e) => !e.none)
      ) {
        noted.add(key);
        log(`[nj-fare] ${key}: next journey on sale is ${returned[0]}, past the calendar's ${windowEnd}`);
      }
    } catch (err) {
      stats.errors++;
      if (err.blocked) {
        // Final for the night: this map does not work around a refusal, and
        // asking again (or about another train) is what a refusal says not to.
        const { status, reason, vendor = null } = err.blocked;
        stats.blocked = { status, reason, vendor };
        stats.stopped = true;
        const body = err.body ? ` — answer began: ${String(err.body).replace(/\s+/g, " ").trim().slice(0, 100)}` : "";
        log(
          `[nj-fare] nightjet.com blocked automated requests (${reason}${vendor ? ` by ${vendor}` : ""}) ` +
            `at ${key} ${date}, request ${stats.requests} — stopping tonight's fare searches; ` +
            `calendars keep last run's nights${body}`,
        );
        break;
      }
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

  // What tonight wrote, read back off the entries themselves.
  for (const [key, written] of writtenTonight) {
    for (const [date, entry] of Object.entries(written)) {
      if (entry.none) {
        stats.none++;
        continue;
      }
      stats.priced++;
      if (!Number.isFinite(entry.seat)) continue;
      stats.seatCompared++;
      const low = berthsAtOrBelowSeat(entry);
      if (low.length) stats.suspects.push({ key, date, seat: entry.seat, classes: Object.fromEntries(low) });
    }
  }
  stats.suspect = stats.suspects.length;
  // The owner's question — "is this couchette figure really a seat price?" —
  // answered in the log every night, whichever way it comes out.
  if (stats.priced) {
    if (!stats.seatCompared) {
      log(`[nj-fare] seat check: none of tonight's ${stats.priced} priced night(s) came with a seat price to compare`);
    } else if (!stats.suspect) {
      log(`[nj-fare] seat check: all ${stats.seatCompared} priced night(s) with a seat price cost more than the seat`);
    } else {
      const shown = 12;
      const list = stats.suspects
        .slice(0, shown)
        .map(({ key, date, seat, classes }) =>
          `${key} ${date} ${Object.entries(classes).map(([cls, amount]) => `${cls} €${amount}`).join(", ")} ≤ seat €${seat}`,
        )
        .join("; ");
      const more = stats.suspect > shown ? `; … and ${stats.suspect - shown} more` : "";
      log(
        `[nj-fare] seat check: ${stats.suspect} of ${stats.seatCompared} priced night(s) cost no more than ` +
          `that night's seat — kept as read, worth checking on nightjet.com: ${list}${more}`,
      );
    }
  }

  for (const [key, train] of Object.entries(trains ?? {})) {
    const cal = calendars[key];
    cal.nights = Object.fromEntries(Object.entries(cal.nights).sort(([a], [b]) => (a < b ? -1 : 1)));
    const entries = Object.values(cal.nights);
    // Which journey the prices are for, so the calendar's Book button can open
    // this train (pricedJourney; each night carries its own clocks).
    // Recomputed every run, and dropped by pruneCalendar.
    const journey = pricedJourney(train);
    if (journey) cal.journey = journey;
    if (entries.length) train.fareCalendar = cal;
    const fare = cheapestNight(cal);
    if (fare) train.fare = fare;
    if (entries.length) {
      const priced = entries.filter((e) => !e.none).length;
      // Why tonight's nights without a fare have none: a journey on sale
      // without a berth (seats only, or nothing left), or no journey that
      // night at all — a train whose berths are gone (or not sold this way)
      // against a train that does not run.
      const why = { noBerth: 0, noJourney: 0 };
      for (const e of Object.values(writtenTonight.get(key) ?? {})) {
        if (e.none && e.reason in why) why[e.reason]++;
      }
      const tonight = why.noBerth + why.noJourney
        ? ` (tonight: ${why.noBerth} on sale without a berth, ${why.noJourney} without a journey)`
        : "";
      log(
        `[nj-fare] ${key}: ${priced}/${entries.length} night(s) priced` +
          (fare ? `, cheapest €${fare.fromPrice} (${fare.seatClass}) on ${fare.travelDate}` : "") +
          tonight,
      );
    }
  }
  return stats;
}
