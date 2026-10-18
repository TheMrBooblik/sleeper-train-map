// scripts/adapters/nightjet.mjs
// NightJet / EuroNight via the official nightjet.com booking API.
// Discovers train numbers from country-pair queries (codes in registry params)
// plus the partner (EuroNight) list, then fetches each train's full route.
// Stores the result on ctx.shared.njTrains so the runner's post-step can merge
// polylines into view_ontd_map and build synthetic standalone routes.
// Each train also carries its fares for every night of the next six weeks,
// read from the same API's price search (scripts/lib/nj-fares.mjs). A fare
// search the host refuses costs tonight's fares, never the trains: run()
// returns it to the runner as a warning for source-health.json.
//
// nightjet.com also sells its partners' EuroNights, and its train answer says
// who runs each one ("Operated by Polnische Bahn PKP"). Each train records
// that sentence and the carrier it names (registry params.operatorAgencies,
// scripts/lib/operator-agencies.mjs), so a partner EuroNight's row carries
// its carrier as agency_id: its name, Book button and timetable link are the
// carrier's, and nightjet.com does not price it (njPricesTrain).

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { FARE_CALENDAR_DAYS } from "../lib/fare-calendar.mjs";
import { describeBlock } from "../lib/http-block.mjs";
import {
  fillNjFareCalendars,
  njPricesTrain,
  NJ_FARE_NEAR_DAYS,
  NJ_FARE_REQUESTS_PER_RUN,
  viennaDate,
} from "../lib/nj-fares.mjs";
import {
  agencyForLineName,
  agencyForOperatorText,
  carrierInAgencyId,
  compileOperatorAgencies,
  publishedElsewhere,
  readOperatorText,
} from "../lib/operator-agencies.mjs";
import { sameTrainAsRow } from "../../src/lib/sameTrain.mjs";
import {
  fillTimetableVariants,
  NJ_TIMETABLE_MIN_NIGHTS,
  NJ_TIMETABLE_READS_PER_RUN,
} from "../lib/nj-timetable-variants.mjs";
import { trackPathFromSiblings } from "../lib/sibling-path.mjs";

function normalizeNJTrain(data, date, operator = "Nightjet") {
  const stops = Array.isArray(data?.route?.stops) ? data.route.stops : [];
  const stations = stops
    .map((s) => {
      const [lat, lon] = s?.station?.coords || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const name =
        s?.station?.name?.de || s?.station?.name?.int || s?.station?.name?.en;
      return {
        id: s?.station?.eva || s?.station?.evaMeta || null,
        name,
        location: { latitude: lat, longitude: lon },
        arrival: s?.arr ? new Date(s.arr).toISOString() : null,
        departure: s?.dep ? new Date(s.dep).toISOString() : null,
        pickup: !!s?.pickup,
        dropoff: !!s?.dropoff,
      };
    })
    .filter(Boolean);

  return {
    lineName: data?.trainNumber,
    operator,
    // Who runs it, in nightjet.com's words ("Operated by Polnische Bahn PKP").
    operatorText: readOperatorText(data?.operator),
    date,
    stations,
    polyline: data?.route?.polyline || null,
    fetchedAt: new Date().toISOString(),
    source: "nightjet-com",
  };
}

async function fetchSingleTrain(trainNumber, date) {
  const encoded = encodeURIComponent(trainNumber);
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encoded}/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[nj] upstream ${res.status} for ${trainNumber}`);
      return null;
    }
    const data = await res.json();
    if (!data?.route?.stops?.length) return null;
    const operator = data.partnerTrain ? "EuroNight" : "Nightjet";
    return normalizeNJTrain(data, date, operator);
  } catch (e) {
    console.warn(`[nj] fetch failed for ${trainNumber}: ${e.message}`);
    return null;
  }
}

/** The Vienna date a normalized train's journey starts on, or null. */
function runDateOf(train) {
  const first = train?.stations?.[0];
  return viennaDate(first?.departure ?? first?.arrival ?? null);
}

/**
 * The fuller of two answers about the same journey: one with nightjet.com's
 * own polyline beats one without, then more stops beat fewer. `onRun` is only
 * taken when it describes the run `asked` returned (same start date), so a
 * second answer about a different journey can never replace the first.
 */
export function richerAnswer(asked, onRun) {
  if (!onRun?.stations?.length) return asked;
  if (!asked?.stations?.length) return onRun;
  if (runDateOf(onRun) !== runDateOf(asked)) return asked;
  const score = (t) => (t.polyline ? 1000 : 0) + t.stations.length;
  // Strictly fuller only: on a tie the first answer stands, so the log below
  // names just the trains the re-read actually repaired.
  return score(onRun) > score(asked) ? onRun : asked;
}

/**
 * A train asked about on `date`, answered from the journey it next runs.
 *
 * nightjet.com answers a date the train does not run with its next journey,
 * and since October 2026 that answer can come back thinned: no polyline and
 * stops without coordinates, which normalizeNJTrain has to drop. EN 1276
 * Rijeka–Warszawa (next run 27 June 2027) arrived without its route line and
 * without Wien Meidling and Wien Hbf, so the map drew a straight line from
 * Wiener Neustadt to Ostrava; asked for 27 June itself, the same endpoint
 * returns both Vienna stops and the full polyline. So a train whose answer
 * starts on a later date is asked again for that date, and the fuller answer
 * is kept — one extra request per train not running tonight.
 * @param {string} trainNumber
 * @param {string} date "YYYY-MM-DD"
 * @param {(n: string, d: string) => Promise<object|null>} [fetchOne]
 */
export async function fetchTrainForNextRun(trainNumber, date, fetchOne = fetchSingleTrain) {
  const asked = await fetchOne(trainNumber, date);
  const runDate = runDateOf(asked);
  if (!asked || !runDate || runDate <= date) return asked;
  const onRun = await fetchOne(trainNumber, runDate);
  const kept = richerAnswer(asked, onRun);
  if (kept !== asked) {
    console.log(
      `[nj] ${trainNumber}: next run ${runDate} — re-read on that date ` +
        `(${asked.stations.length}→${kept.stations.length} stops${!asked.polyline && kept.polyline ? ", polyline gained" : ""})`,
    );
  }
  return kept;
}

/**
 * Route lines for trains nightjet.com sent without one, drawn along the
 * track of the trains it did send one for.
 *
 * The answer for NJ 449 (from 8 February 2027, Brussels–Wien via Frankfurt,
 * Würzburg, Nürnberg and Passau) carries stops and no polyline on every date
 * asked, so the adapter's fallback was a straight chord between each pair of
 * stations, and the map drew it as one. Every stretch of that routing is
 * ridden by another Nightjet the same answer set does draw (NJ 469 to Köln and
 * Koblenz, NJ 40421 from there to Wien), so `trackPathFromSiblings` lends each
 * gap the donor track that runs between its two stops. A gap no donor covers
 * stays a chord. `ownLines` names the trains whose line is nightjet.com's own:
 * only those lend, so a borrowed line is never borrowed from again.
 * @param {Record<string, {polyline: string, stations: object[]}>} trains
 * @param {Set<string>} ownLines
 * @returns {string[]} the trains whose line was rebuilt
 */
export function borrowTrackGeometry(trains, ownLines) {
  const donors = [...ownLines]
    .map((key) => trains[key]?.polyline)
    .filter(Boolean)
    .map((encoded) => polyline.decode(encoded));
  const rebuilt = [];
  for (const [key, train] of Object.entries(trains)) {
    if (ownLines.has(key)) continue;
    const stops = (train.stations ?? [])
      .filter((s) => s.location?.latitude && s.location?.longitude)
      .map((s) => [s.location.latitude, s.location.longitude]);
    if (stops.length < 2) continue;
    const { path, filled, gaps } = trackPathFromSiblings(stops, donors);
    if (!filled) continue;
    train.polyline = polyline.encode(path);
    rebuilt.push(`${key} (${filled}/${gaps} stretches)`);
  }
  return rebuilt;
}

async function fetchNJTrainNumbers(date, countryCodes) {
  const pairs = [];
  for (const from of countryCodes)
    for (const to of countryCodes) pairs.push([from, to]);

  const njNumbers = new Set();
  await Promise.all(
    pairs.map(async ([from, to]) => {
      const url = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from}/country/${to}/${date}`;
      try {
        const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const trains = await res.json();
        if (!Array.isArray(trains)) return;
        trains.forEach((t) => {
          if (t?.trainNumber && !t.partnerTrain) njNumbers.add(t.trainNumber);
        });
      } catch (e) {
        console.warn(`[nj] country ${from}/${to} failed: ${e.message}`);
      }
    }),
  );
  return Array.from(njNumbers);
}

async function fetchPartnerTrainNumbers(date, max = 25) {
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((t) => t?.trainNumber).filter(Boolean).slice(0, max);
  } catch (e) {
    console.warn(`[nj] partner fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Price tonight's trains night by night, building on last night's calendars.
 * Never fatal: a fare failure costs the fares, not the trains. Resolves the
 * pass's stats, `{ failed }` when the pass itself threw, null when fares are
 * off. Exported for tests (tests/verify-nj-fares.mjs).
 */
export async function priceTrains(results, entry, ctx, previous = readPreviousTrains(entry, ctx)) {
  const {
    enabled = true,
    days = FARE_CALENDAR_DAYS,
    requestsPerRun = NJ_FARE_REQUESTS_PER_RUN,
    nearDays = NJ_FARE_NEAR_DAYS,
  } = entry.params?.fares ?? {};
  // A partner EuroNight is its carrier's to price: never carried from last
  // night's file, and `fare: null` says so to stampOfficialFares, which then
  // gives the row no fare model rather than its operator's default.
  const priced = {};
  for (const [key, train] of Object.entries(results ?? {})) {
    if (njPricesTrain(train)) {
      priced[key] = train;
    } else {
      delete train.fareCalendar;
      train.fare = null;
    }
  }
  if (!enabled) return null;
  try {
    const stats = await fillNjFareCalendars(priced, previous, {
      today: ctx.today,
      fetchImpl: ctx.fetch ?? fetchWithTimeout,
      days,
      requests: requestsPerRun,
      nearDays,
    });
    const ending = stats.blocked
      ? `, ${describeBlock(stats.blocked)} and stopped`
      : stats.stopped
        ? ", stopped early"
        : "";
    console.log(
      `[scrape] nightjet fares: ${stats.requests} request(s) tonight` +
        `${stats.retries ? ` (${stats.retries} retried)` : ""}, ${stats.priced} night(s) priced, ` +
        `${stats.none} without a berth or a train, ${stats.errors} failed` +
        `${stats.capped ? ", budget spent" : ""}${ending}; ` +
        `${stats.suspect} of ${stats.seatCompared} seat-checked night(s) at or below the seat price; ` +
        `fares for ${Object.values(priced).filter((t) => t.fare).length}/${Object.keys(priced).length} trains` +
        (Object.keys(results).length > Object.keys(priced).length
          ? ` (${Object.keys(results).length - Object.keys(priced).length} partner EuroNight(s) left to their carrier)`
          : ""),
    );
    return stats;
  } catch (err) {
    console.warn(`[scrape] nightjet fares failed: ${err.message} — trains kept without fares`);
    return { failed: err.message };
  }
}

/**
 * Each night's own stop list, one read per clock the calendar shows and the
 * run does not answer (scripts/lib/nj-timetable-variants.mjs). Skipped on a
 * night the fare search was refused: the same host would refuse this too.
 */
export async function readTimetableVariants(results, entry, ctx, previous, fareStats, fetchTrain = fetchSingleTrain) {
  const {
    enabled = true,
    readsPerRun = NJ_TIMETABLE_READS_PER_RUN,
    minNights = NJ_TIMETABLE_MIN_NIGHTS,
  } = entry.params?.timetableVariants ?? {};
  if (!enabled) return null;
  if (fareStats?.blocked) {
    console.log("[scrape] nightjet timetables: skipped, the fare search was refused tonight");
    return null;
  }
  const stats = await fillTimetableVariants(results, previous, {
    today: ctx.today,
    fetchTrain,
    reads: readsPerRun,
    minNights,
  });
  const trains = Object.values(results).filter((t) => t.timetableVariants).length;
  console.log(
    `[scrape] nightjet timetables: ${stats.read} read tonight (${stats.kept} kept, ` +
      `${stats.mismatched} answered another clock, ${stats.failed} unanswered), ` +
      `${stats.carried} carried from earlier nights, ${stats.rare} clock(s) under ${minNights} nights left unread; ` +
      `${trains} train(s) with a timetable per clock` +
      `${stats.capped ? `, budget spent (${stats.planned - stats.read} left for tomorrow)` : ""}` +
      `${stats.stopped ? ", stopped after repeated failures" : ""}`,
  );
  return stats;
}

/** Last night's trains file, or null on a first run. */
function readPreviousTrains(entry, ctx) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(ctx.rootDir, "public", "data", "scraped", entry.output), "utf8"),
    );
    return raw?.data?.trains ?? raw?.trains ?? null;
  } catch {
    return null; // first run, or unreadable: nothing to build on
  }
}

/**
 * Back-on-Track's attribution per train number, from the view map: what a
 * partner train falls back to when nightjet.com's own operator text names no
 * carrier. Rows carrying the source's own idPrefix are skipped — they are
 * this pipeline's leftover rows, and reading them back would echo our own
 * last answer as Back-on-Track's. With `trains`, a row counts only for the
 * train it describes (sameTrainAsRow): Back-on-Track's EN 442 is ČD's
 * Humenné–Praha, not the Budapest–Stuttgart EN 442 nightjet.com sells.
 * @param {object|null} viewMap
 * @param {string} idPrefix
 * @param {Record<string, object>} [trains]
 * @returns {Map<string, string>}
 */
export function backOnTrackAgencies(viewMap, idPrefix, trains = null) {
  const out = new Map();
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    const id = String(route?.route_id ?? key);
    if (idPrefix && (id.startsWith(idPrefix) || String(key).startsWith(idPrefix))) continue;
    const agency = String(route?.agency_id ?? "").trim();
    if (!agency) continue;
    for (const dir of [0, 1]) {
      const name = String(route?.[`trip_short_name_${dir}`] ?? "").trim();
      if (!name || out.has(name)) continue;
      if (trains?.[name] && !sameTrainAsRow(route, trains[name])) continue;
      out.set(name, agency);
    }
  }
  return out;
}

/**
 * Give every train the carrier that runs it: `agency_id`, and `agencyFrom`
 * saying how it was decided.
 *
 * - An ÖBB Nightjet is the home carrier ("home"). Text naming a partner on
 *   one is logged, not applied.
 * - A partner EuroNight takes the carrier its operator text names
 *   ("operator"), else the carrier whose train-number prefix it carries
 *   ("line": "ES 452" → ES). With no text tonight, last night's stated
 *   carrier is kept; text naming no known carrier is not carried, since a
 *   changed sentence may mean a changed carrier.
 * - Failing that, the first carrier in Back-on-Track's attribution that is
 *   not home ("bot": "HŽPP/ÖBB" → HŽPP — never the compound, which would
 *   book through ÖBB's shop by link quality).
 * - Failing that, home ("home"), reported as a problem.
 *
 * Mutates the trains; returns a report for the log and source-health.
 * @param {Record<string, object>} trains
 * @param {{ compiled: object, previous?: Record<string, object>|null, botAgencies?: Map<string,string> }} opts
 */
export function assignTrainAgencies(trains, { compiled, previous = null, botAgencies = new Map() }) {
  const report = { counts: {}, byAgency: {}, problems: [], notes: [] };
  const count = (from, agency) => {
    report.counts[from] = (report.counts[from] ?? 0) + 1;
    report.byAgency[agency] = (report.byAgency[agency] ?? 0) + 1;
  };
  for (const [key, train] of Object.entries(trains ?? {})) {
    const verdict = agencyForOperatorText(train.operatorText, compiled);
    const partner = train.operator === "EuroNight";
    if (!partner) {
      train.agency_id = compiled.home;
      train.agencyFrom = "home";
      if (verdict.status === "matched" || verdict.status === "ambiguous") {
        report.notes.push(`${key} is a Nightjet but its operator text names ${verdict.all.join(", ")} ("${train.operatorText}") — kept ${compiled.home}`);
      }
      count("home", compiled.home);
      continue;
    }
    if (verdict.status === "matched" || verdict.status === "ambiguous" || verdict.status === "home") {
      train.agency_id = verdict.agency;
      train.agencyFrom = "operator";
      if (verdict.status === "ambiguous") {
        report.notes.push(`${key}: "${train.operatorText}" names ${verdict.all.join(", ")} — took ${verdict.agency}, named first`);
      }
      count("operator", verdict.agency);
      continue;
    }
    const byLine = agencyForLineName(key, compiled);
    if (byLine) {
      train.agency_id = byLine;
      train.agencyFrom = "line";
      count("line", byLine);
      continue;
    }
    const before = previous?.[key];
    if (verdict.status === "missing" && before?.agencyFrom === "operator" && before.agency_id) {
      train.agency_id = before.agency_id;
      train.agencyFrom = "operator";
      if (before.operatorText) train.operatorText = before.operatorText;
      report.notes.push(`${key}: no operator text tonight — kept last night's ${before.agency_id}`);
      count("operator", before.agency_id);
      continue;
    }
    const fromBot = carrierInAgencyId(botAgencies.get(key), compiled);
    const what =
      verdict.status === "missing"
        ? "no operator text"
        : `operator text "${train.operatorText}" names no carrier in params.operatorAgencies`;
    if (fromBot) {
      train.agency_id = fromBot;
      train.agencyFrom = "bot";
      report.problems.push(`${key}: ${what} — using Back-on-Track's ${fromBot}`);
      count("bot", fromBot);
    } else {
      train.agency_id = compiled.home;
      train.agencyFrom = "home";
      report.problems.push(`${key}: ${what} and no Back-on-Track carrier — using ${compiled.home}`);
      count("home", compiled.home);
    }
  }
  return report;
}

/**
 * What tonight's fare pass leaves in source-health.json, or null on a night
 * that went as planned. A refused or abandoned fare search is worth a line
 * there and is not a failed source: the trains, their timetables and last
 * run's calendars are all written. The runner records it as a warning beside
 * the success (scripts/scrape-data.mjs sourceHealthRecord).
 */
export function fareWarning(stats) {
  if (!stats) return null;
  if (stats.failed) return `fare pass failed: ${stats.failed}`;
  if (stats.blocked) {
    return (
      `fare search ${describeBlock(stats.blocked)} at request ${stats.requests} — ` +
      "stopped for the night; calendars keep last run's nights"
    );
  }
  if (stats.stopped) {
    return `fare search stopped after ${stats.errors} failed request(s) of ${stats.requests}`;
  }
  return null;
}

export async function run(entry, ctx) {
  const { countryCodes = [], concurrency = 6, maxPartnerTrains = 25 } = entry.params ?? {};
  const results = {};

  const [njNumbers, enNumbers] = await Promise.all([
    fetchNJTrainNumbers(ctx.today, countryCodes),
    fetchPartnerTrainNumbers(ctx.today, maxPartnerTrains),
  ]);
  const allNumbers = [...new Set([...njNumbers, ...enNumbers])];
  console.log(`[scrape] fetching ${allNumbers.length} NJ/EN trains`);

  const ownLines = new Set();
  for (let i = 0; i < allNumbers.length; i += concurrency) {
    const batch = allNumbers.slice(i, i + concurrency);
    const fetched = await Promise.all(batch.map((n) => fetchTrainForNextRun(n, ctx.today)));
    fetched.forEach((train) => {
      if (!train) return;
      const fallbackPositions = train.stations
        .filter((s) => s.location?.latitude && s.location?.longitude)
        .map((s) => [s.location.latitude, s.location.longitude]);
      const encodedPolyline =
        train.polyline ||
        (fallbackPositions.length >= 2 ? polyline.encode(fallbackPositions) : null);
      if (!encodedPolyline) return;
      if (train.polyline) ownLines.add(train.lineName);
      results[train.lineName] = {
        lineName: train.lineName,
        operator: train.operator,
        operatorText: train.operatorText,
        polyline: encodedPolyline,
        stations: train.stations,
      };
    });
  }

  const rebuilt = borrowTrackGeometry(results, ownLines);
  if (rebuilt.length) {
    console.log(`[nj] no route line from nightjet.com, drawn along other trains' track: ${rebuilt.join(", ")}`);
  }

  const previous = readPreviousTrains(entry, ctx);
  let operatorWarning = null;
  if (entry.params?.operatorAgencies) {
    const viewMap =
      ctx.shared?.viewMap ?? readScraped(ctx.rootDir, "backontrack-view_ontd_map.json") ?? {};
    const compiled = compileOperatorAgencies(entry.params.operatorAgencies);
    const report = assignTrainAgencies(results, {
      compiled,
      previous,
      botAgencies: backOnTrackAgencies(viewMap, entry.synthetic?.idPrefix, results),
    });
    // A carrier whose trains another source publishes (European Sleeper's
    // ES 452/453/475, sold here too) is left to that source: a second copy
    // of the route under the shop's name, priced by the shop, is what the
    // map showed when nightjet.com began listing them.
    const handedOver = {};
    for (const [key, train] of Object.entries(results)) {
      const by = publishedElsewhere(train.agency_id, compiled);
      if (!by) continue;
      (handedOver[by] ??= []).push(key);
      delete results[key];
    }
    for (const [by, keys] of Object.entries(handedOver)) {
      console.log(`[scrape] nightjet: left ${keys.sort().join(", ")} to ${by}, which publishes them`);
    }
    const by = Object.entries(report.byAgency)
      .sort((a, b) => b[1] - a[1])
      .map(([agency, n]) => `${agency} ${n}`)
      .join(", ");
    const from = Object.entries(report.counts)
      .map(([k, n]) => `${n} from ${k}`)
      .join(", ");
    console.log(`[scrape] nightjet operators: ${by} (${from})`);
    for (const note of report.notes) console.log(`[nj] ${note}`);
    for (const problem of report.problems) console.warn(`[nj] ${problem}`);
    if (report.problems.length) {
      operatorWarning = `${report.problems.length} partner train(s) without a stated carrier: ${report.problems.join("; ")}`;
    }
  }

  const fareStats = await priceTrains(results, entry, ctx, previous);
  await readTimetableVariants(results, entry, ctx, previous, fareStats);

  ctx.write(entry.output, { uploadedAt: ctx.today, trains: results });
  console.log(`[scrape] stored ${Object.keys(results).length} NJ/EN trains`);
  // Use what was actually persisted (sticky merge may retain extra trains).
  ctx.shared.njTrains = ctx.writtenTrains?.[entry.output] ?? results;

  // Returned, not thrown: a throw would record the source as failed, and the
  // trains it exists for were fetched and written above.
  const warning = [fareWarning(fareStats), operatorWarning].filter(Boolean).join("; ");
  if (warning) console.warn(`[scrape] nightjet: ${warning}`);
  return warning ? { warning } : null;
}

/** A committed scrape artifact, for what ctx.shared may not carry yet. */
function readScraped(rootDir, name) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, "public", "data", "scraped", name), "utf8"));
    return raw?.data ?? null;
  } catch {
    return null;
  }
}
