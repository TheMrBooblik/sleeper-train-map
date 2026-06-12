// scripts/adapters/nightjet.mjs
// NightJet / EuroNight via the official nightjet.com booking API.
// Discovers train numbers from country-pair queries (codes in registry params)
// plus the partner (EuroNight) list, then fetches each train's full route.
// Stores the result on ctx.shared.njTrains so the runner's post-step can merge
// polylines into view_ontd_map and build synthetic standalone routes.

import polyline from "@mapbox/polyline";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";

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

export async function run(entry, ctx) {
  const {
    countryCodes = [],
    concurrency = 6,
    maxPartnerTrains = 25,
    scanOffsets = [0],
  } = entry.params ?? {};
  const results = {};

  // Scan several dates across the booking horizon, not just tonight: trains
  // with planned future start dates (seasonal NightJets, December-timetable
  // routes) are announced in the booking API months ahead and must appear on
  // the map as soon as they're published. Each train number is remembered
  // with the EARLIEST date it was seen running, so detail fetches reflect the
  // soonest operation.
  const scanDates = [...new Set(scanOffsets)]
    .sort((a, b) => a - b)
    .map((days) =>
      new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );

  const firstDateByNumber = new Map();
  for (const date of scanDates) {
    const [njNumbers, enNumbers] = await Promise.all([
      fetchNJTrainNumbers(date, countryCodes),
      fetchPartnerTrainNumbers(date, maxPartnerTrains),
    ]);
    let added = 0;
    for (const n of [...njNumbers, ...enNumbers]) {
      if (!firstDateByNumber.has(n)) {
        firstDateByNumber.set(n, date);
        added++;
      }
    }
    if (date !== scanDates[0] && added > 0) {
      console.log(`[scrape] NJ horizon ${date}: ${added} train(s) not running tonight`);
    }
  }
  const allNumbers = [...firstDateByNumber.keys()];
  console.log(
    `[scrape] fetching ${allNumbers.length} NJ/EN trains (${scanDates.length} horizon date(s))`,
  );

  for (let i = 0; i < allNumbers.length; i += concurrency) {
    const batch = allNumbers.slice(i, i + concurrency);
    const fetched = await Promise.all(
      batch.map((n) => fetchSingleTrain(n, firstDateByNumber.get(n))),
    );
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

  ctx.write(entry.output, { uploadedAt: ctx.today, trains: results });
  console.log(`[scrape] stored ${Object.keys(results).length} NJ/EN trains`);
  // Use what was actually persisted (sticky merge may retain extra trains).
  ctx.shared.njTrains = ctx.writtenTrains?.[entry.output] ?? results;
}
