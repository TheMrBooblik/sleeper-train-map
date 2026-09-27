// scripts/adapters/viaggiatreno.mjs
// Trenitalia Intercity Notte (ICN) via the public Viaggiatreno API. The train
// numbers to query live in the registry entry params (data, not code).

import polyline from "@mapbox/polyline";
import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout, titleCase } from "../lib/scrape-helpers.mjs";
import { romeClock, searchTimeBefore, searchTrainFare } from "../lib/lefrecce.mjs";
import {
  cheapestNight,
  FARE_CALENDAR_BUDGET,
  FARE_CALENDAR_DAYS,
  planFareSearches,
  pruneCalendar,
} from "../lib/fare-calendar.mjs";

// Fares are yield-managed, so each night has its own price: the adapter keeps
// a calendar per train (the next six weeks) and refreshes a budgeted slice of
// it every run — see scripts/lib/fare-calendar.mjs. Spacing keeps the load on
// the operator's booking backend at about one search a second.
const FARE_REQUEST_SPACING_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIAGGIATRENO_BASE = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";

async function fetchItalianTrain(trainNumber) {
  let autoText;
  try {
    const autoRes = await fetchWithTimeout(
      `${VIAGGIATRENO_BASE}/cercaNumeroTrenoTrenoAutocomplete/${trainNumber}`,
      { headers: { "User-Agent": "train-map/1.0" } },
    );
    if (!autoRes.ok) return null;
    autoText = await autoRes.text();
  } catch {
    return null;
  }

  // Parse: "795 - TORINO PORTA NUOVA - 18/05/26|795-S00219-1779055200000\n..."
  const entries = autoText.trim().split("\n").filter(Boolean).map((line) => {
    const pipeIdx = line.indexOf("|");
    if (pipeIdx === -1) return null;
    const key = line.slice(pipeIdx + 1).trim();
    const parts = key.split("-");
    if (parts.length < 3) return null;
    const stationCode = parts[1];
    const timestamp = parseInt(parts[2], 10);
    if (!stationCode || !Number.isFinite(timestamp)) return null;
    return { stationCode, timestamp };
  }).filter(Boolean);

  if (!entries.length) return null;

  // Fetch all sections; keep only ICN category, pick the one with most stops
  let best = null;
  for (const { stationCode, timestamp } of entries) {
    try {
      const res = await fetchWithTimeout(
        `${VIAGGIATRENO_BASE}/andamentoTreno/${stationCode}/${trainNumber}/${timestamp}`,
        { headers: { "User-Agent": "train-map/1.0", accept: "application/json" } },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.categoria !== "ICN") continue;
      const fermate = Array.isArray(data?.fermate) ? data.fermate : [];
      if (fermate.length < 2) continue;
      if (!best || fermate.length > best.fermate.length) {
        best = { data, fermate };
      }
    } catch {
      continue;
    }
  }

  if (!best) return null;

  const stationCodes = [...new Set(best.fermate.map((s) => s.id).filter(Boolean))];
  return { trainNumber, fermate: best.fermate, stationCodes };
}

async function fetchStationCoords(codes) {
  const coordMap = new Map();
  const CONCURRENCY = 10;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (code) => {
      try {
        const res = await fetchWithTimeout(
          `${VIAGGIATRENO_BASE}/dettaglioStazione/${code}/0`,
          { headers: { "User-Agent": "train-map/1.0" } },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Number.isFinite(data?.lat) && Number.isFinite(data?.lon)) {
          coordMap.set(code, { lat: data.lat, lon: data.lon });
        }
      } catch { /* skip */ }
    }));
  }
  return coordMap;
}

async function buildItalianTrains(trainNumbers, concurrency) {
  // Fetch all trains concurrently in batches
  const rawTrains = [];
  for (let i = 0; i < trainNumbers.length; i += concurrency) {
    const batch = trainNumbers.slice(i, i + concurrency);
    const fetched = await Promise.all(batch.map((n) => fetchItalianTrain(n)));
    fetched.forEach((t, idx) => {
      if (t) rawTrains.push(t);
      else console.warn(`[icn] no ICN data for train ${batch[idx]}`);
    });
  }

  // Collect all unique station codes and batch-fetch coordinates
  const allCodes = [...new Set(rawTrains.flatMap((t) => t.stationCodes))];
  console.log(`[icn] fetching coordinates for ${allCodes.length} unique stations`);
  const coordMap = await fetchStationCoords(allCodes);

  // Build normalized trains
  const trains = {};
  for (const { trainNumber, fermate } of rawTrains) {
    const stations = fermate.map((s) => {
      const coords = coordMap.get(s.id);
      if (!coords) return null;
      return {
        name: titleCase(s.stazione),
        // Viaggiatreno's own station id ("S12349" = Siracusa). Kept because it
        // is the only way to address a train on the operator's site: its
        // per-train page is cercaTreno.jsp?treno=1962&origine=S12349&…, and the
        // origin code is not derivable from the station name. See the schedule
        // links in src/lib/operatorBooking.js.
        code: s.id || null,
        location: { latitude: coords.lat, longitude: coords.lon },
        arrival: s.arrivo_teorico ? new Date(s.arrivo_teorico).toISOString() : null,
        departure: s.partenza_teorica ? new Date(s.partenza_teorica).toISOString() : null,
      };
    }).filter(Boolean);

    if (stations.length < 2) {
      console.warn(`[icn] ICN ${trainNumber}: too few stations with coords (${stations.length})`);
      continue;
    }

    const positions = stations.map((s) => [s.location.latitude, s.location.longitude]);
    const lineName = `ICN ${trainNumber}`;
    trains[lineName] = {
      lineName,
      operator: "Trenitalia",
      polyline: polyline.encode(positions),
      stations,
    };
    console.log(`[icn] built ${lineName}: ${stations[0].name} → ${stations[stations.length - 1].name} (${stations.length} stops)`);
  }

  return trains;
}

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

export async function run(entry, ctx) {
  const {
    trainNumbers = [],
    concurrency = 4,
    fareCalendarDays = FARE_CALENDAR_DAYS,
    fareSearchesPerRun = FARE_CALENDAR_BUDGET,
  } = entry.params ?? {};
  const trains = await buildItalianTrains(trainNumbers, concurrency);

  // Last night's file: the calendar is built up across runs. The headline fare
  // is not carried separately — it is always the cheapest night the (pruned,
  // current-version) calendar holds, so a price read under an older rule, such
  // as a Young fare before v3, cannot come back through a side door.
  let previous = null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(ctx.rootDir, "public", "data", "scraped", entry.output), "utf8"),
    );
    previous = raw?.data?.trains ?? raw?.trains ?? null;
  } catch {
    /* first run, or unreadable: nothing to build on */
  }

  const stats = await fillFareCalendars(trains, previous, {
    today: ctx.today,
    fetchImpl: ctx.fetch ?? fetch,
    days: fareCalendarDays,
    budget: fareSearchesPerRun,
  });
  console.log(
    `[scrape] italian: ${stats.searched}/${stats.planned} fare search(es) tonight ` +
      `(${stats.priced} priced, ${stats.none} without a berth, ${stats.noTrain} with no direct train, ` +
      `${stats.errors} failed${stats.stopped ? ", stopped early" : ""}); ` +
      `fares for ${Object.values(trains).filter((t) => t.fare).length}/${Object.keys(trains).length} trains`,
  );

  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  console.log(`[scrape] stored ${Object.keys(trains).length} Italian ICN trains`);
}
