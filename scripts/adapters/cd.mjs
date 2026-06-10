// scripts/adapters/cd.mjs
// Czech Railways EC/EN timetables scraped from cd.cz HTML pages. The set of
// train numbers to fetch is derived from Back-on-Track trips (ctx.shared.trips,
// populated by the backontrack adapter earlier in the registry order).

import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";

function extractTrainNumbers(trips, prefix) {
  if (!trips || typeof trips !== "object") return [];
  const seen = new Set();
  const re = new RegExp(`^\\s*${prefix}\\s+(\\d+)`, "i");
  for (const trip of Object.values(trips)) {
    const name = (trip.trip_short_name || "").toString().trim();
    const match = name.match(re);
    if (match) seen.add(match[1]);
  }
  return Array.from(seen);
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

async function fetchCDTrain(trainNumber, trainType = "EC") {
  const url = `https://www.cd.cz/en/vlak/${trainNumber}`;
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
    if (!result) console.warn(`[cd] parse failed for ${trainType} ${trainNumber}`);
    return result;
  } catch (e) {
    console.warn(`[cd] fetch failed for ${trainType} ${trainNumber}: ${e.message}`);
    return null;
  }
}

export async function run(entry, ctx) {
  const { trainNumberPrefixes = ["EC", "EN"], concurrency = 6 } = entry.params ?? {};
  const trips = ctx.shared.trips;
  const cdResults = {};

  for (const prefix of trainNumberPrefixes) {
    const numbers = extractTrainNumbers(trips, prefix);
    for (let i = 0; i < numbers.length; i += concurrency) {
      const batch = numbers.slice(i, i + concurrency);
      const fetched = await Promise.all(batch.map((n) => fetchCDTrain(n, prefix)));
      fetched.forEach((train) => { if (train) cdResults[train.trainNumber] = train; });
    }
  }

  ctx.write(entry.output, { uploadedAt: ctx.today, trains: cdResults });
  console.log(`[scrape] stored ${Object.keys(cdResults).length} CD trains`);
}
