// scripts/lib/es-fare-calendar.mjs
// European Sleeper's fare calendar: every night of the next six weeks for each
// train, from the operator's booking API (./es-fares.mjs), with the
// last-minute deals the operator's own fare finder leaves out
// (./es-last-minute.mjs) laid over the nights they exist.
//
// The calendar has the same shape as the Intercity Notte one, so the build's
// stampOfficialFares and the connection page's FareCalendar read it unchanged:
//   { version, currency: "EUR", nights: { "2026-10-12": {
//       classes: { couchette: 79.99, sleeperTriple: 139.99, lastMinuteCouchette: 40 },
//       fareTypes: { couchette: "easy-night" },
//       deal: { landing: "/last-minutes-berlin-prague", checkedAt },
//       checkedAt } | { none: true, checkedAt } } }
// A deal's price lives in `classes` beside the regular ones, so the headline
// "from" and the cheapest-night pick see it like any other fare; `deal` says
// where it is sold, since a deal is not bookable through the ordinary search.

import {
  cheapestNight,
  FARE_CALENDAR_DAYS,
  planFareSearches,
  pruneCalendar,
} from "./fare-calendar.mjs";
import {
  classesFromAvailability,
  constantsStations,
  fetchConstants,
  nightsFromTrainSearch,
  resolveStationId,
  searchAvailability,
  searchTrains,
} from "./es-fares.mjs";

/** Six trains × 42 nights is 252: the whole calendar fits in one night's run. */
export const ES_FARE_BUDGET = 300;
const SPACING_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A deal is shown for the night it was read and the next, never longer. */
export const DEAL_MAX_AGE_DAYS = 1;

export const DEAL_CLASS = { couchette: "lastMinuteCouchette", private: "lastMinutePrivate" };
const DEAL_CLASSES = new Set(Object.values(DEAL_CLASS));

const DAY_MS = 86_400_000;
const isoMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Take every deal out of a calendar, returning them as a list. Deals are read
 * fresh each night and a sold-out one must not linger, so they are stripped
 * before the night's run and laid back on after it. A night that carried
 * nothing BUT a deal goes entirely — its regular fares were never read, and
 * leaving it would tell the planner it had been.
 */
export function stripDeals(calendar, train) {
  const removed = [];
  for (const [date, entry] of Object.entries(calendar?.nights ?? {})) {
    if (!entry?.classes) continue;
    for (const [cls, amount] of Object.entries(entry.classes)) {
      if (!DEAL_CLASSES.has(cls)) continue;
      removed.push({
        train,
        date,
        kind: cls === DEAL_CLASS.private ? "private" : "couchette",
        amount,
        landing: entry.deal?.landing ?? null,
        checkedAt: entry.deal?.checkedAt ?? entry.checkedAt,
      });
      delete entry.classes[cls];
    }
    delete entry.deal;
    if (!Object.keys(entry.classes).length) {
      if (entry.dealOnly) delete calendar.nights[date];
      else {
        delete entry.classes;
        delete entry.fareTypes;
        entry.none = true;
      }
    }
    if (calendar.nights[date]) delete calendar.nights[date].dealOnly;
  }
  return removed;
}

/**
 * Lay deals onto the calendars: [{ train, date, kind, amount, landing,
 * checkedAt }]. Two deals of one kind on one night keep the cheaper. A deal
 * on a night the regular search found nothing on sale still counts — the
 * promo quota is sold separately — and replaces the `none`.
 */
export function applyDeals(calendars, deals, { today, days = FARE_CALENDAR_DAYS } = {}) {
  let applied = 0;
  const last = isoMs(today) + days * DAY_MS;
  for (const d of deals ?? []) {
    const cal = calendars[d.train];
    const cls = DEAL_CLASS[d.kind];
    if (!cal || !cls || !Number.isFinite(d.amount) || d.amount <= 0) continue;
    if (!(d.date > today) || isoMs(d.date) > last) continue;
    const entry = cal.nights[d.date];
    const checkedAt = d.checkedAt ?? today;
    if (!entry || entry.none) {
      cal.nights[d.date] = {
        classes: { [cls]: d.amount },
        checkedAt: entry?.checkedAt ?? checkedAt,
        ...(entry ? {} : { dealOnly: true }),
        deal: { landing: d.landing ?? null, checkedAt },
      };
    } else {
      entry.classes ??= {};
      if (entry.classes[cls] == null || d.amount < entry.classes[cls]) entry.classes[cls] = d.amount;
      entry.deal = { landing: entry.deal?.landing ?? d.landing ?? null, checkedAt };
    }
    applied++;
  }
  return applied;
}

/** Whole-journey station ids per train: { "453": { fromId, toId, from, to } }. */
export function endpointsFor(trains, { curated, stations, log = () => {} }) {
  const out = {};
  for (const [key, train] of Object.entries(trains)) {
    const first = train.stations?.[0]?.name;
    const last = train.stations?.[train.stations.length - 1]?.name;
    const fromId = resolveStationId(first, { curated, stations });
    const toId = resolveStationId(last, { curated, stations });
    if (fromId && toId) out[key] = { fromId, toId, from: first, to: last };
    else log(`[es-fare] ${key}: no operator station id for ${fromId ? last : first} — not priced`);
  }
  return out;
}

/**
 * Bring every train's calendar up to date and set its headline fare to the
 * cheapest night. Never throws: a failing train is skipped for the night, and
 * a run of failures stops the pass — that is the operator turning us away.
 *
 * @param {object} trains          tonight's trains, keyed by bare number
 * @param {object|null} previousTrains last night's file, for the calendars
 * @param {object} opts
 * @param {Record<string,string>} opts.curated  operator-booking.json stationNames
 * @param {() => Promise<object>} [opts.loadDeals] tonight's deals
 *   (fetchLastMinuteDeals); omitted = no deal pass
 */
export async function fillEsFareCalendars(
  trains,
  previousTrains,
  {
    today,
    fetchImpl = fetch,
    log = console.log,
    curated = {},
    days = FARE_CALENDAR_DAYS,
    budget = ES_FARE_BUDGET,
    spacingMs = SPACING_MS,
    maxConsecutiveErrors = 5,
    loadDeals = null,
  } = {},
) {
  const stats = {
    planned: 0, searched: 0, requests: 0, priced: 0, none: 0, errors: 0, stopped: false,
    deals: 0, dealsFrom: null, unpriced: [],
  };
  const calendars = {};
  const previousDeals = [];
  for (const key of Object.keys(trains)) {
    const previous = previousTrains?.[key]?.fareCalendar ?? { currency: "EUR", nights: {} };
    calendars[key] = pruneCalendar(previous, { today, days });
    calendars[key].currency = "EUR";
    previousDeals.push(...stripDeals(calendars[key], key));
  }

  let constants = null;
  try {
    constants = await fetchConstants({ fetchImpl });
    stats.requests++;
  } catch (err) {
    log(`[es-fare] /constants failed (${err.message}) — station ids from the curated map only`);
  }
  const stations = constantsStations(constants);
  const maxDate = String(constants?.settings?.maxReservationDate ?? "").slice(0, 10) || null;
  const endpoints = endpointsFor(trains, { curated, stations, log });
  stats.unpriced = Object.keys(trains).filter((k) => !endpoints[k]);

  const searchable = Object.fromEntries(Object.keys(endpoints).map((k) => [k, calendars[k]]));
  const plan = planFareSearches(searchable, { today, days, budget }).filter(
    (p) => !maxDate || p.date <= maxDate,
  );
  stats.planned = plan.length;

  // /search/trains answers three nights at a time; remember what it said.
  const known = new Map(); // `${key}|${date}` → { routeId, trip } | null
  const broken = new Set();
  let consecutiveErrors = 0;
  const pause = () => (spacingMs ? sleep(spacingMs) : null);

  for (const { key, date } of plan) {
    if (broken.has(key)) continue;
    const ep = endpoints[key];
    try {
      let hit = known.get(`${key}|${date}`);
      if (hit === undefined) {
        const body = await searchTrains({ fromId: ep.fromId, toId: ep.toId, date }, { fetchImpl });
        stats.requests++;
        await pause();
        const nights = nightsFromTrainSearch(body, key);
        for (const [d, v] of Object.entries(nights)) known.set(`${key}|${d}`, v);
        hit = known.get(`${key}|${date}`) ?? null;
      }
      stats.searched++;
      consecutiveErrors = 0;
      if (!hit || hit.trip?.bookable === false || !hit.routeId) {
        calendars[key].nights[date] = { none: true, checkedAt: today };
        stats.none++;
        continue;
      }
      const availability = await searchAvailability(
        { routeId: hit.routeId, fromId: ep.fromId, toId: ep.toId, trainNumber: key, date },
        { fetchImpl },
      );
      stats.requests++;
      await pause();
      const { classes, fareTypes, seen } = classesFromAvailability(availability);
      if (Object.keys(classes).length) {
        calendars[key].nights[date] = {
          classes,
          ...(Object.keys(fareTypes).length ? { fareTypes } : {}),
          checkedAt: today,
        };
        stats.priced++;
      } else {
        calendars[key].nights[date] = { none: true, checkedAt: today };
        stats.none++;
        if (seen.length && !stats.loggedSeats) {
          stats.loggedSeats = true;
          log(`[es-fare] ${key} ${date}: no berth on sale among [${seen.join(", ")}]`);
        }
      }
    } catch (err) {
      stats.errors++;
      consecutiveErrors++;
      broken.add(key);
      log(`[es-fare] ${key} ${date}: ${err.message}${err.body ? ` — ${err.body}` : ""} — skipping its other nights tonight`);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        stats.stopped = true;
        log(`[es-fare] ${consecutiveErrors} failures in a row — stopping tonight's fare searches`);
        break;
      }
    }
  }

  // Deals: tonight's when the pages could be read, else yesterday's (one day
  // old at most) rather than none on a network blip.
  let deals = [];
  if (loadDeals) {
    try {
      const result = await loadDeals();
      if (result?.ok) deals = result.deals.map((d) => ({ ...d, checkedAt: today }));
      else {
        deals = previousDeals.filter((d) => (isoMs(today) - isoMs(d.checkedAt)) / DAY_MS <= DEAL_MAX_AGE_DAYS);
        log(`[es-deals] no landing page could be read — keeping ${deals.length} deal(s) from the last run`);
      }
    } catch (err) {
      log(`[es-deals] failed (${err.message}) — no deals tonight`);
    }
  }
  stats.deals = applyDeals(calendars, deals, { today, days });
  const dealAmounts = deals.filter((d) => d.kind === "couchette").map((d) => d.amount);
  stats.dealsFrom = dealAmounts.length ? Math.min(...dealAmounts) : null;

  for (const [key, train] of Object.entries(trains)) {
    const cal = calendars[key];
    cal.nights = Object.fromEntries(Object.entries(cal.nights).sort(([a], [b]) => (a < b ? -1 : 1)));
    const entries = Object.values(cal.nights);
    if (entries.length) train.fareCalendar = cal;
    const fare = cheapestNight(cal);
    if (fare) train.fare = fare;
    if (entries.length) {
      const priced = entries.filter((e) => !e.none).length;
      const withDeal = entries.filter((e) => e.deal).length;
      log(
        `[es-fare] ${key}: ${priced}/${entries.length} night(s) priced` +
          (withDeal ? `, ${withDeal} with a last-minute deal` : "") +
          (fare ? `, cheapest €${fare.fromPrice} (${fare.seatClass}) on ${fare.travelDate}` : ""),
      );
    }
  }
  delete stats.loggedSeats;
  return stats;
}
