// scripts/adapters/nightjet.mjs
// NightJet / EuroNight via the official nightjet.com booking API.
// Discovers train numbers from country-pair queries (codes in registry params)
// plus the partner (EuroNight) list, then fetches each train's full route.
// Stores the result on ctx.shared.njTrains so the runner's post-step can merge
// polylines into view_ontd_map and build synthetic standalone routes.

import polyline from "@mapbox/polyline";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { repairPolylinesThroughStops } from "../lib/polyline-repair.mjs";

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

  // The API can hand a diverted train its regular routing's polyline (NJ 11446
  // arrived with NJ 446's, 55 km from its own Schwarzach stop) — rebuild any
  // train whose line misses one of its stops. See polyline-repair.mjs.
  const { trains: checked, repaired } = repairPolylinesThroughStops(results);
  for (const r of repaired) {
    console.warn(
      `[nj] ${r.key}: API polyline misses its own stops by up to ${r.beforeKm.toFixed(0)} km ` +
        `(${r.missed.join(", ")}) — rebuilt through them ` +
        `(${r.borrowed} leg(s) from other trains, ${r.straight} straight)`,
    );
  }

  ctx.write(entry.output, { uploadedAt: ctx.today, trains: checked });
  console.log(`[scrape] stored ${Object.keys(checked).length} NJ/EN trains`);
  // Use what was actually persisted (sticky merge may retain extra trains).
  ctx.shared.njTrains = ctx.writtenTrains?.[entry.output] ?? checked;
}
