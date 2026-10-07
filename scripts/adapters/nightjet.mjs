// scripts/adapters/nightjet.mjs
// NightJet / EuroNight via the official nightjet.com booking API.
// Discovers train numbers from country-pair queries (codes in registry params)
// plus the partner (EuroNight) list, then fetches each train's full route.
// Stores the result on ctx.shared.njTrains so the runner's post-step can merge
// polylines into view_ontd_map and build synthetic standalone routes.
// Each train also carries its fares for every night of the next six weeks,
// read from the same API's price search (scripts/lib/nj-fares.mjs).

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { FARE_CALENDAR_DAYS } from "../lib/fare-calendar.mjs";
import { fillNjFareCalendars, NJ_FARE_REQUESTS_PER_RUN } from "../lib/nj-fares.mjs";

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
 * Never fatal: a fare failure costs the fares, not the trains.
 */
async function priceTrains(results, entry, ctx) {
  const { enabled = true, days = FARE_CALENDAR_DAYS, requestsPerRun = NJ_FARE_REQUESTS_PER_RUN } =
    entry.params?.fares ?? {};
  if (!enabled) return;
  let previous = null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(ctx.rootDir, "public", "data", "scraped", entry.output), "utf8"),
    );
    previous = raw?.data?.trains ?? raw?.trains ?? null;
  } catch {
    /* first run, or unreadable: nothing to build on */
  }
  try {
    const stats = await fillNjFareCalendars(results, previous, {
      today: ctx.today,
      fetchImpl: ctx.fetch ?? fetchWithTimeout,
      days,
      requests: requestsPerRun,
    });
    console.log(
      `[scrape] nightjet fares: ${stats.requests} request(s) tonight` +
        `${stats.retries ? ` (${stats.retries} retried)` : ""}, ${stats.priced} night(s) priced, ` +
        `${stats.none} without a berth or a train, ${stats.errors} failed` +
        `${stats.capped ? ", budget spent" : ""}${stats.stopped ? ", stopped early" : ""}; ` +
        `fares for ${Object.values(results).filter((t) => t.fare).length}/${Object.keys(results).length} trains`,
    );
  } catch (err) {
    console.warn(`[scrape] nightjet fares failed: ${err.message} — trains kept without fares`);
  }
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
        polyline: encodedPolyline,
        stations: train.stations,
      };
    });
  }

  await priceTrains(results, entry, ctx);

  ctx.write(entry.output, { uploadedAt: ctx.today, trains: results });
  console.log(`[scrape] stored ${Object.keys(results).length} NJ/EN trains`);
  // Use what was actually persisted (sticky merge may retain extra trains).
  ctx.shared.njTrains = ctx.writtenTrains?.[entry.output] ?? results;
}
