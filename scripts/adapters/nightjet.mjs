// scripts/adapters/nightjet.mjs
// NightJet / EuroNight via the official nightjet.com booking API.
// Discovers train numbers from country-pair queries (codes in registry params)
// plus the partner (EuroNight) list, over `params.discoveryDays` dates starting
// tonight, then fetches each train's full route on the first date it runs.
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

export async function fetchSingleTrain(trainNumber, date) {
  const encoded = encodeURIComponent(trainNumber);
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encoded}/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[nj] upstream ${res.status} for ${trainNumber} on ${date}`);
      return null;
    }
    const data = await res.json();
    if (!data?.route?.stops?.length) return null;
    const operator = data.partnerTrain ? "EuroNight" : "Nightjet";
    return normalizeNJTrain(data, date, operator);
  } catch (e) {
    console.warn(`[nj] fetch failed for ${trainNumber} on ${date}: ${e.message}`);
    return null;
  }
}

/**
 * Every train the country-pair search lists for one date, partner EuroNights
 * included. They used to be dropped here and taken only from the partner list,
 * which the adapter cut at 25 — so a partner train the country search had
 * found could still go missing.
 */
export async function fetchCountryTrains(date, countryCodes) {
  const pairs = [];
  for (const from of countryCodes)
    for (const to of countryCodes) pairs.push([from, to]);

  const numbers = new Set();
  let failed = 0;
  await Promise.all(
    pairs.map(async ([from, to]) => {
      const url = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from}/country/${to}/${date}`;
      try {
        const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
        if (!res.ok) {
          failed++;
          return;
        }
        const trains = await res.json();
        if (!Array.isArray(trains)) return;
        trains.forEach((t) => {
          if (t?.trainNumber) numbers.add(t.trainNumber);
        });
      } catch (e) {
        failed++;
        console.warn(`[nj] country ${from}/${to} on ${date} failed: ${e.message}`);
      }
    }),
  );
  return { numbers: Array.from(numbers), failed, pairs: pairs.length };
}

/** The partner (EuroNight) list for one date, uncut. */
export async function fetchPartnerTrains(date) {
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { numbers: [], ok: false };
    const data = await res.json();
    const numbers = [
      ...new Set((Array.isArray(data) ? data : []).map((t) => t?.trainNumber).filter(Boolean)),
    ];
    return { numbers, ok: true };
  } catch (e) {
    console.warn(`[nj] partner fetch on ${date} failed: ${e.message}`);
    return { numbers: [], ok: false };
  }
}

/** `days` consecutive ISO dates starting at `today` ("YYYY-MM-DD"). */
export function discoveryDates(today, days = 1) {
  const [y, m, d] = String(today).split("-").map(Number);
  const out = [];
  for (let i = 0; i < Math.max(1, days); i++) {
    out.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Which trains the API lists over a window of dates, and on which of them.
 *
 * One date was never enough. The adapter asked only for tonight, and the
 * scrape runner trusts a healthy fetch completely — a train missing from it is
 * dropped the same night — so a train that does not run tonight left the map
 * until the night it ran again. ÖBB also gives every diversion its own number
 * (NJ 498/499 for Hamburg–Wien over the summer works, NJ 11446, 13465, 13487…),
 * each listed only on the dates it runs. A week covers every weekday pattern.
 *
 * @returns {Promise<{ datesByTrain: Map<string, string[]>, perDate: object[],
 *   partnerTruncated: { date: string, listed: number }[] }>}
 */
export async function discoverTrains({ dates, countryCodes, maxPartnerTrains = Infinity }) {
  const datesByTrain = new Map();
  const perDate = [];
  const partnerTruncated = [];
  for (const date of dates) {
    const [country, partner] = await Promise.all([
      fetchCountryTrains(date, countryCodes),
      fetchPartnerTrains(date),
    ]);
    // A cap that cuts silently is how a train goes missing without a trace:
    // keep it as a guard against a runaway response, but say when it bites.
    const partnerKept = partner.numbers.slice(0, maxPartnerTrains);
    if (partner.numbers.length > partnerKept.length) {
      partnerTruncated.push({ date, listed: partner.numbers.length });
    }
    const listed = new Set([...country.numbers, ...partnerKept]);
    for (const n of listed) {
      if (!datesByTrain.has(n)) datesByTrain.set(n, []);
      datesByTrain.get(n).push(date);
    }
    perDate.push({
      date,
      country: country.numbers.length,
      countryFailed: country.failed,
      partner: partner.numbers.length,
      partnerOk: partner.ok,
      listed: listed.size,
    });
  }
  return { datesByTrain, perDate, partnerTruncated };
}

// A train's route on the first listed date that returns one: the earliest
// date wins, so a train running tonight is drawn with tonight's routing.
async function fetchFirstRunning(trainNumber, dates, maxTries = 3) {
  for (const date of dates.slice(0, maxTries)) {
    const train = await fetchSingleTrain(trainNumber, date);
    if (train) return train;
  }
  return null;
}

export async function run(entry, ctx) {
  const {
    countryCodes = [],
    concurrency = 6,
    maxPartnerTrains = Infinity,
    discoveryDays = 7,
  } = entry.params ?? {};
  const results = {};

  const dates = discoveryDates(ctx.today, discoveryDays);
  const { datesByTrain, perDate, partnerTruncated } = await discoverTrains({
    dates,
    countryCodes,
    maxPartnerTrains,
  });
  for (const d of perDate) {
    console.log(
      `[nj] ${d.date}: ${d.listed} train(s) listed — country search ${d.country}` +
        `${d.countryFailed ? ` (${d.countryFailed} pair request(s) failed)` : ""}, ` +
        `partner list ${d.partnerOk ? d.partner : "unavailable"}`,
    );
  }
  for (const t of partnerTruncated) {
    console.warn(
      `[nj] ${t.date}: partner list has ${t.listed} trains, only the first ${maxPartnerTrains} kept — raise params.maxPartnerTrains`,
    );
  }
  const notTonight = [...datesByTrain]
    .filter(([, listed]) => listed[0] !== dates[0])
    .map(([n, listed]) => `${n} (${listed[0]})`);
  if (notTonight.length) {
    console.log(`[nj] listed later this week but not tonight: ${notTonight.join(", ")}`);
  }

  const allNumbers = [...datesByTrain.keys()];
  console.log(`[scrape] fetching ${allNumbers.length} NJ/EN trains over ${dates.length} day(s)`);

  const missingRoute = [];
  for (let i = 0; i < allNumbers.length; i += concurrency) {
    const batch = allNumbers.slice(i, i + concurrency);
    const fetched = await Promise.all(
      batch.map((n) => fetchFirstRunning(n, datesByTrain.get(n))),
    );
    fetched.forEach((train, j) => {
      if (!train) {
        missingRoute.push(batch[j]);
        return;
      }
      const fallbackPositions = train.stations
        .filter((s) => s.location?.latitude && s.location?.longitude)
        .map((s) => [s.location.latitude, s.location.longitude]);
      const encodedPolyline =
        train.polyline ||
        (fallbackPositions.length >= 2 ? polyline.encode(fallbackPositions) : null);
      if (!encodedPolyline) {
        missingRoute.push(batch[j]);
        return;
      }
      results[train.lineName] = {
        lineName: train.lineName,
        operator: train.operator,
        polyline: encodedPolyline,
        stations: train.stations,
      };
    });
  }
  if (missingRoute.length) {
    console.warn(
      `[nj] listed but no route returned, so not on the map: ${missingRoute.join(", ")}`,
    );
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
