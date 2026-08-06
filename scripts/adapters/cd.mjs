// scripts/adapters/cd.mjs
// Czech Railways EC/EN timetables scraped from cd.cz HTML pages. The set of
// train numbers to fetch is derived from Back-on-Track trips (ctx.shared.trips,
// populated by the backontrack adapter earlier in the registry order), together
// with the endpoints Back-on-Track expects — cd.cz needs both.
//
// A bare /vlak/{number} lookup is ambiguous: cd.cz resolves the number against
// every operator it knows, so "EN 40459" (Zürich–Praha) came back as a
// Strasbourg–Kehl local and "EN 11443" as a Bratislava suburban service. Two
// defences: `params.trainUrls` pins the full cd.cz deep link for routes where
// the bare number is known to resolve wrong, and every response — pinned or
// not — must run between the endpoints the requesting trip claims, or it is
// discarded rather than stored as that train.

import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { stopsRunBetween } from "../lib/station-city.mjs";

/**
 * Train numbers to fetch, each with the endpoint pairs Back-on-Track expects
 * for it (one number can serve several rows).
 * @returns {{number: string, endpoints: {origin: string, destination: string}[]}[]}
 */
function extractTrainRequests(trips, prefix) {
  if (!trips || typeof trips !== "object") return [];
  const byNumber = new Map();
  const re = new RegExp(`^\\s*${prefix}\\s+(\\d+)`, "i");
  for (const trip of Object.values(trips)) {
    const name = (trip.trip_short_name || "").toString().trim();
    const match = name.match(re);
    if (!match) continue;
    if (!byNumber.has(match[1])) byNumber.set(match[1], []);
    byNumber.get(match[1]).push({
      origin: trip.trip_origin,
      destination: trip.trip_headsign,
    });
  }
  return [...byNumber].map(([number, endpoints]) => ({ number, endpoints }));
}

/** cd.cz writes journey dates as D.M.YYYY. */
function cdDate(now = new Date()) {
  return `${now.getDate()}.${now.getMonth() + 1}.${now.getFullYear()}`;
}

/**
 * The cd.cz path for a train: a pinned deep link when the registry has one
 * (its `_DATE_` placeholder filled with today), else the bare number.
 */
export function cdTrainPath(number, trainUrls = {}, now = new Date()) {
  const pinned = trainUrls?.[String(number)];
  if (!pinned) return String(number);
  return String(pinned).replace("_DATE_", cdDate(now));
}

function parseCDTrainHTML(html, trainNumber, trainType) {
  const strategies = [
    () => {
      const m = html.match(/var\s+model\s*=\s*([\s\S]+?);\s*new\s+TrainDetail/);
      if (m) {
        const model = JSON.parse(m[1]);
        return model?.trainDetailTimetable?.route;
      }
    },
    () => {
      const m = html.match(/"trainDetailTimetable"\s*:\s*\{[^}]*"route"\s*:\s*(\[[\s\S]+?\])\s*\}/);
      if (m) return JSON.parse(m[1]);
    },
    () => {
      const m = html.match(/trainDetailTimetable\s*:\s*\{[^}]*route\s*:\s*(\[[\s\S]+?\])\s*\}/);
      if (m) return JSON.parse(m[1]);
    },
  ];

  for (const strategy of strategies) {
    try {
      const route = strategy();
      if (Array.isArray(route) && route.length > 0) {
        const stops = route
          .map((s) => ({ name: s.name || s.stationName || null, arrival: s.timeArr || null, departure: s.timeDep || null }))
          .filter((s) => s.name);
        if (stops.length > 0) {
          return { trainNumber: String(trainNumber), trainLabel: `${trainType} ${trainNumber}`, fetchedAt: new Date().toISOString(), stops };
        }
      }
    } catch {
      // try next strategy
    }
  }
  return null;
}

async function fetchCDTrain(request, trainType = "EC", trainUrls = {}) {
  const { number: trainNumber, endpoints } = request;
  const url = `https://www.cd.cz/en/vlak/${cdTrainPath(trainNumber, trainUrls)}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "train-map/1.0 (timetable-display)", Accept: "text/html" },
    });
    if (!res.ok) {
      console.warn(`[cd] HTTP ${res.status} for ${trainType} ${trainNumber}`);
      return null;
    }
    const html = await res.text();
    const result = parseCDTrainHTML(html, trainNumber, trainType);
    if (!result) {
      console.warn(`[cd] parse failed for ${trainType} ${trainNumber}`);
      return null;
    }
    // cd.cz answers a bare number with whichever train it matched first, which
    // is regularly a different operator's local service. Only keep a response
    // that actually runs the journey the requesting row describes.
    const serves = (endpoints ?? []).some((e) =>
      stopsRunBetween(result.stops, e.origin, e.destination),
    );
    if (!serves) {
      const ends = `${result.stops?.[0]?.name} → ${result.stops?.[result.stops.length - 1]?.name}`;
      console.warn(
        `[cd] discarded ${trainType} ${trainNumber}: cd.cz returned ${ends}, ` +
          `which serves none of ${JSON.stringify(endpoints)}`,
      );
      return null;
    }
    return result;
  } catch (e) {
    console.warn(`[cd] fetch failed for ${trainType} ${trainNumber}: ${e.message}`);
    return null;
  }
}

export async function run(entry, ctx) {
  const {
    trainNumberPrefixes = ["EC", "EN"],
    concurrency = 6,
    trainUrls = {},
  } = entry.params ?? {};
  const trips = ctx.shared.trips;
  const cdResults = {};

  for (const prefix of trainNumberPrefixes) {
    const requests = extractTrainRequests(trips, prefix);
    for (let i = 0; i < requests.length; i += concurrency) {
      const batch = requests.slice(i, i + concurrency);
      const fetched = await Promise.all(
        batch.map((r) => fetchCDTrain(r, prefix, trainUrls)),
      );
      fetched.forEach((train) => { if (train) cdResults[train.trainNumber] = train; });
    }
  }

  ctx.write(entry.output, { uploadedAt: ctx.today, trains: cdResults });
  console.log(`[scrape] stored ${Object.keys(cdResults).length} CD trains`);
}
