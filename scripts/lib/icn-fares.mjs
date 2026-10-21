// scripts/lib/icn-fares.mjs
// Trenitalia Intercity Notte fare calendars, read from lefrecce.it (the
// operator's own booking backend). Lifted out of the old Viaggiatreno adapter
// unchanged when the timetable moved to the national GTFS
// (scripts/adapters/trenitalia-gtfs.mjs): the fares never depended on where
// the timetable came from, only on each train's first/last station code
// (Viaggiatreno's "S01700", which is the GTFS stop_id "01700" with an S) and
// its departure clock.

import { romeClock, searchTimeBefore, searchTrainFare } from "./lefrecce.mjs";
import {
  cheapestNight,
  FARE_CALENDAR_BUDGET,
  FARE_CALENDAR_DAYS,
  planFareSearches,
  pruneCalendar,
} from "./fare-calendar.mjs";

// Fares are yield-managed, so each night has its own price: the adapter keeps
// a calendar per train (the next six weeks) and refreshes a budgeted slice of
// it every run — see scripts/lib/fare-calendar.mjs. Spacing keeps the load on
// the operator's booking backend at about one search a second.
const FARE_REQUEST_SPACING_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Search one train on one night on lefrecce.it, the operator's own booking
 * backend, for the whole journey (first to last station). Resolves
 * { entry, seen, solutions }: `entry` is the night's calendar entry —
 * { classes, checkedAt } when a berth is on sale, { none: true, checkedAt }
 * when the answer holds no berth on our train (it does not run that night, or
 * its berths are gone). Throws on a transport or shape error, which says
 * nothing about the night. Exported for tests.
 */
export async function searchIcnNight(train, date, { today, fetchImpl = fetch, ids = new Map(), otherTrains = [] } = {}) {
  const trainNumber = String(train.lineName ?? "").replace(/\D/g, "");
  const first = train.stations?.[0];
  const last = train.stations?.[train.stations.length - 1];
  const clock = romeClock(first?.departure);
  if (!trainNumber || !first?.code || !last?.code || !clock) {
    throw new Error("no station codes/departure to search with");
  }
  const { fare, solutions, seen, offers } = await searchTrainFare(
    {
      fromCode: first.code,
      toCode: last.code,
      fromName: first.name,
      toName: last.name,
      date,
      time: searchTimeBefore(clock),
      trainNumber,
      departureClock: clock,
      otherTrains,
    },
    { fetchImpl, ids },
  );
  const entry = fare
    ? { classes: { ...fare.classes }, checkedAt: today }
    : { none: true, checkedAt: today };
  return { entry, seen, solutions, clock, matchedBy: fare?.matchedBy ?? null, offers };
}

/**
 * Bring every train's fare calendar up to date within tonight's budget and
 * set its headline fare to its cheapest night (scripts/lib/fare-calendar.mjs).
 * Never throws: a train whose search fails is skipped for the rest of the
 * night (another date will not fix a refused station or a block page), and a
 * run of failures across trains stops the whole pass — that is the operator
 * turning us away, and hammering on would only make it worse.
 * Exported for tests.
 */
export async function fillFareCalendars(
  trains,
  previousTrains,
  {
    today,
    fetchImpl = fetch,
    log = console.log,
    ids = new Map(),
    days = FARE_CALENDAR_DAYS,
    budget = FARE_CALENDAR_BUDGET,
    spacingMs = FARE_REQUEST_SPACING_MS,
    maxConsecutiveErrors = 5,
  } = {},
) {
  const calendars = {};
  for (const key of Object.keys(trains)) {
    const previous = previousTrains?.[key]?.fareCalendar ?? { currency: "EUR", nights: {} };
    calendars[key] = pruneCalendar(previous, { today, days });
    calendars[key].currency ??= "EUR";
  }
  const plan = planFareSearches(calendars, { today, days, budget });
  const stats = { planned: plan.length, searched: 0, priced: 0, none: 0, noTrain: 0, errors: 0, stopped: false };
  const broken = new Set();
  const missLogged = new Set();
  // Every train number we track: a departure-minute match must never take one
  // of them for another (lefrecce.mjs findTrainSolution).
  const numberOf = (t) => String(t?.lineName ?? "").replace(/\D/g, "");
  const tracked = Object.values(trains).map(numberOf).filter(Boolean);
  // A train whose stations lefrecce has answered for, tonight or before.
  const proven = new Set(Object.keys(calendars).filter((k) => Object.keys(calendars[k].nights).length));
  const refusals = new Map();
  const offerNames = { kept: new Set(), dropped: new Set() };
  let consecutiveErrors = 0;
  for (const { key, date } of plan) {
    if (broken.has(key)) continue;
    try {
      const own = numberOf(trains[key]);
      const { entry, seen, solutions, clock, matchedBy, offers } = await searchIcnNight(trains[key], date, {
        today,
        fetchImpl,
        ids,
        otherTrains: tracked.filter((n) => n !== own),
      });
      for (const n of offers?.kept ?? []) offerNames.kept.add(n);
      for (const n of offers?.dropped ?? []) offerNames.dropped.add(n);
      consecutiveErrors = 0;
      refusals.set(key, 0);
      proven.add(key);
      stats.searched++;
      calendars[key].nights[date] = entry;
      if (entry.none) {
        stats.none++;
        // One miss per train is enough to diagnose it; forty would bury the log.
        if (!missLogged.has(key)) {
          missLogged.add(key);
          log(`[icn-fare] ${key} ${date}: not among ${solutions} solution(s) [${seen.join("; ")}] — ours leaves ${clock}`);
        }
      } else {
        stats.priced++;
        if (matchedBy !== "number" && !missLogged.has(`${key}:by`)) {
          missLogged.add(`${key}:by`);
          log(`[icn-fare] ${key} ${date}: matched by ${matchedBy}`);
        }
      }
    } catch (err) {
      if (err.status === 400) {
        // lefrecce answers 400 when there is no direct train at all on the
        // pair that night — Milano → Siracusa has exactly one, ICN 1963, so a
        // night it does not run is a 400, not an error. A refused station id
        // is a 400 too, which is why a train that has never been answered for
        // is given up on after three in a row (searchTrainFare has already
        // tried the name lookup by then).
        const streak = (refusals.get(key) ?? 0) + 1;
        refusals.set(key, streak);
        stats.searched++;
        stats.noTrain++;
        calendars[key].nights[date] = { none: true, checkedAt: today };
        if (!proven.has(key) && streak >= 3) {
          broken.add(key);
          log(`[icn-fare] ${key} ${date}: HTTP 400 three times and never answered — skipping its other nights tonight`);
        }
        continue;
      }
      stats.errors++;
      consecutiveErrors++;
      broken.add(key);
      log(`[icn-fare] ${key} ${date}: ${err.message} — skipping its other nights tonight`);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        stats.stopped = true;
        log(`[icn-fare] ${consecutiveErrors} failures in a row — stopping tonight's fare searches`);
        break;
      }
    } finally {
      if (spacingMs) await sleep(spacingMs);
    }
  }

  // What the grids really call their offers, and which ones the adult rule
  // priced: the one place a new Young/Senior-style name would show up.
  if (offerNames.kept.size || offerNames.dropped.size) {
    log(`[icn-fare] offers priced (standard adult): ${[...offerNames.kept].sort().join(", ") || "none"}`);
    log(`[icn-fare] offers left out (restricted): ${[...offerNames.dropped].sort().join(", ") || "none"}`);
  }
  for (const [key, train] of Object.entries(trains)) {
    const cal = calendars[key];
    cal.nights = Object.fromEntries(Object.entries(cal.nights).sort(([a], [b]) => (a < b ? -1 : 1)));
    const entries = Object.values(cal.nights);
    if (entries.length) train.fareCalendar = cal;
    const fare = cheapestNight(cal);
    if (fare) train.fare = fare;
    if (entries.length) {
      const priced = entries.filter((e) => !e.none).length;
      log(
        `[icn-fare] ${key}: ${priced}/${entries.length} night(s) priced` +
          (fare ? `, cheapest €${fare.fromPrice} (${fare.seatClass}) on ${fare.travelDate}` : ""),
      );
    }
  }
  return stats;
}

