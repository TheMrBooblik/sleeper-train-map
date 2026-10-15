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
} from "../lib/nj-fares.mjs";
import {
  agencyForOperatorText,
  carrierInAgencyId,
  compileOperatorAgencies,
  readOperatorText,
} from "../lib/operator-agencies.mjs";

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
 * last answer as Back-on-Track's.
 * @param {object|null} viewMap
 * @param {string} idPrefix
 * @returns {Map<string, string>}
 */
export function backOnTrackAgencies(viewMap, idPrefix) {
  const out = new Map();
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    const id = String(route?.route_id ?? key);
    if (idPrefix && (id.startsWith(idPrefix) || String(key).startsWith(idPrefix))) continue;
    const agency = String(route?.agency_id ?? "").trim();
    if (!agency) continue;
    for (const dir of [0, 1]) {
      const name = String(route?.[`trip_short_name_${dir}`] ?? "").trim();
      if (name && !out.has(name)) out.set(name, agency);
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
 *   ("operator"). With no text tonight, last night's stated carrier is kept;
 *   text naming no known carrier is not carried, since a changed sentence may
 *   mean a changed carrier.
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

  for (let i = 0; i < allNumbers.length; i += concurrency) {
    const batch = allNumbers.slice(i, i + concurrency);
    const fetched = await Promise.all(batch.map((n) => fetchSingleTrain(n, ctx.today)));
    fetched.forEach((train) => {
      if (!train) return;
      const fallbackPositions = train.stations
        .filter((s) => s.location?.latitude && s.location?.longitude)
        .map((s) => [s.location.latitude, s.location.longitude]);
      const encodedPolyline =
        train.polyline ||
        (fallbackPositions.length >= 2 ? polyline.encode(fallbackPositions) : null);
      if (!encodedPolyline) return;
      results[train.lineName] = {
        lineName: train.lineName,
        operator: train.operator,
        operatorText: train.operatorText,
        polyline: encodedPolyline,
        stations: train.stations,
      };
    });
  }

  const previous = readPreviousTrains(entry, ctx);
  let operatorWarning = null;
  if (entry.params?.operatorAgencies) {
    const viewMap =
      ctx.shared?.viewMap ?? readScraped(ctx.rootDir, "backontrack-view_ontd_map.json") ?? {};
    const report = assignTrainAgencies(results, {
      compiled: compileOperatorAgencies(entry.params.operatorAgencies),
      previous,
      botAgencies: backOnTrackAgencies(viewMap, entry.synthetic?.idPrefix),
    });
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
