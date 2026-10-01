// scripts/adapters/nightjet.mjs
// NightJet / EuroNight via the official nightjet.com booking API.
// Discovers every listed train from country-pair queries and the partner
// (EuroNight) list — the registry's country codes are only a seed, the rest are
// learned from the API's own answers (see discoverTrains) — and fetches each
// train's full route on the date it next runs.
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
 * A station's UIC country code: the API's own `country` field where it sends
 * one ("80"), else the first two digits of its seven-digit EVA number, which is
 * how UIC numbers stations (8011160 Berlin Hbf → 80, 5500003 Budapest-Keleti →
 * 55). Route stops carry only the EVA number.
 */
export function stationCountry(station) {
  const own = station?.country;
  if (own != null && /^\d{2}$/.test(String(own))) return String(own);
  const eva = String(station?.eva || station?.evaMeta || station?.id || "");
  return /^\d{7}$/.test(eva) ? eva.slice(0, 2) : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One entry of a listing (country search or partner list). `date` is the
 * train's next run on or after the date asked about, not that date: the
 * partner list for 1 October carries EN 40465 as "2026-10-15".
 */
export function readListingEntry(entry, queryDate) {
  return {
    trainNumber: entry?.trainNumber || null,
    date: ISO_DATE.test(entry?.date ?? "") ? entry.date : queryDate,
    countries: [stationCountry(entry?.stationFrom), stationCountry(entry?.stationTo)].filter(Boolean),
    partnerTrain: !!entry?.partnerTrain,
  };
}

async function fetchListing(url, queryDate) {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, entries: [] };
    const body = await res.json();
    return {
      ok: true,
      entries: (Array.isArray(body) ? body : [])
        .map((e) => readListingEntry(e, queryDate))
        .filter((e) => e.trainNumber),
    };
  } catch (e) {
    console.warn(`[nj] ${url} failed: ${e.message}`);
    return { ok: false, entries: [] };
  }
}

/**
 * Trains running from one country into another (or within one): every train
 * calling in `from` and later in `to`, partner EuroNights included. A pair
 * outside the registry's six answers too — 54 (Czechia) → 81 (Austria) lists
 * EN 40417 Przemyśl → München and NJ 457 Berlin → Graz.
 */
export function fetchCountryPair(from, to, date) {
  return fetchListing(
    `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from}/country/${to}/${date}`,
    date,
  );
}

/** The partner (EuroNight) list for one date, uncut. */
export function fetchPartnerTrains(date) {
  return fetchListing(`https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`, date);
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

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

// Rounds of "query the new country pairs, fetch the new trains' routes" per
// date. Each round can only add countries, and there are a few dozen of them.
const MAX_ROUNDS = 8;

/**
 * Every train nightjet.com lists, with its route — found without being told
 * which countries or which trains to look for.
 *
 * Countries: the registry's codes are only a seed. Every listing entry names
 * the countries of its two ends, every route names the country of each stop
 * (EVA prefix), and each country seen adds its pairs to the search, until no
 * new one appears. A train into a country nothing else serves is found as long
 * as anything ÖBB lists touches that country; the partner list adds every
 * EuroNight's countries before the first round.
 *
 * Dates: the scrape runner drops a train the moment a healthy fetch omits it,
 * so a train must be found on any night, not only the nights it runs. The live
 * listings answer with each train's NEXT run — the partner list and the
 * country search for 1 October both carry EN 40465 as 15 October — which makes
 * tonight enough; an API that only listed tonight's trains would need the
 * whole window. So the window is walked until the country search is seen
 * answering with a later date than the one asked, which today is the first.
 *
 * Routes are fetched on each train's own next date, the night it runs.
 *
 * @returns {Promise<{ trains: Map<string, { nextDate: string, listedOn: string[],
 *   partnerTrain: boolean, route: object|null }>, countries: string[],
 *   perDate: object[], partnerTruncated: object[], lookAhead: boolean }>}
 */
export async function discoverTrains({
  seedCodes = [],
  dates,
  maxPartnerTrains = Infinity,
  concurrency = 12,
  stopOnLookAhead = true,
  fetchRoutes = true,
}) {
  const known = new Set(seedCodes.map(String));
  const trains = new Map();
  const queried = new Set();
  const perDate = [];
  const partnerTruncated = [];
  let lookAhead = false;

  const note = (entry, queryDate, fromCountrySearch) => {
    entry.countries.forEach((c) => known.add(c));
    if (fromCountrySearch && entry.date > queryDate) lookAhead = true;
    const t = trains.get(entry.trainNumber);
    if (!t) {
      trains.set(entry.trainNumber, {
        nextDate: entry.date,
        listedOn: [queryDate],
        partnerTrain: entry.partnerTrain,
        route: null,
        tried: false,
      });
      return;
    }
    if (entry.date < t.nextDate) t.nextDate = entry.date;
    if (!t.listedOn.includes(queryDate)) t.listedOn.push(queryDate);
    t.partnerTrain ||= entry.partnerTrain;
  };

  const fetchNewRoutes = async () => {
    if (!fetchRoutes) return;
    const pending = [...trains].filter(([, t]) => !t.tried);
    await pool(pending, concurrency, async ([n, t]) => {
      t.tried = true;
      for (const d of [...new Set([t.nextDate, ...t.listedOn])].slice(0, 3)) {
        t.route = await fetchSingleTrain(n, d);
        if (t.route) break;
      }
      for (const s of t.route?.stations ?? []) {
        const c = stationCountry(s);
        if (c) known.add(c);
      }
    });
  };

  for (const [i, date] of dates.entries()) {
    if (i > 0 && stopOnLookAhead && lookAhead) break;
    const before = trains.size;

    const partner = await fetchPartnerTrains(date);
    const partnerKept = partner.entries.slice(0, maxPartnerTrains);
    if (partner.entries.length > partnerKept.length) {
      partnerTruncated.push({ date, listed: partner.entries.length });
    }
    partnerKept.forEach((e) => note(e, date, false));

    let requests = 0;
    let failed = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const pairs = [];
      for (const from of known)
        for (const to of known) {
          const key = `${date}|${from}>${to}`;
          if (!queried.has(key)) {
            queried.add(key);
            pairs.push([from, to]);
          }
        }
      if (!pairs.length) break;
      const answers = await pool(pairs, concurrency, ([from, to]) => fetchCountryPair(from, to, date));
      for (const a of answers) {
        requests++;
        if (!a.ok) failed++;
        a.entries.forEach((e) => note(e, date, true));
      }
      await fetchNewRoutes();
    }
    // Partner trains on a date with no new country pair still need routes.
    await fetchNewRoutes();

    perDate.push({
      date,
      newTrains: trains.size - before,
      countries: known.size,
      countryRequests: requests,
      countryFailed: failed,
      partner: partner.entries.length,
      partnerOk: partner.ok,
    });
  }

  return {
    trains,
    countries: [...known].sort(),
    perDate,
    partnerTruncated,
    lookAhead,
  };
}

export async function run(entry, ctx) {
  const {
    countryCodes = [],
    concurrency = 12,
    maxPartnerTrains = Infinity,
    discoveryDays = 7,
  } = entry.params ?? {};
  const results = {};

  const dates = discoveryDates(ctx.today, discoveryDays);
  const { trains, countries, perDate, partnerTruncated, lookAhead } = await discoverTrains({
    seedCodes: countryCodes,
    dates,
    maxPartnerTrains,
    concurrency,
  });
  for (const d of perDate) {
    console.log(
      `[nj] ${d.date}: +${d.newTrains} train(s); ${d.countryRequests} country-pair request(s)` +
        `${d.countryFailed ? ` (${d.countryFailed} failed)` : ""} over ${d.countries} countries; ` +
        `partner list ${d.partnerOk ? d.partner : "unavailable"}`,
    );
  }
  const seed = new Set(countryCodes.map(String));
  const learned = countries.filter((c) => !seed.has(c));
  console.log(
    `[nj] countries searched: ${countries.join(", ")}` +
      (learned.length ? ` (${learned.join(", ")} learned from the API, beyond the registry's seed)` : ""),
  );
  console.log(
    lookAhead
      ? `[nj] the country search lists each train's next run, so ${perDate.length} date(s) sufficed`
      : `[nj] the country search lists only the date asked, so ${perDate.length} date(s) were walked`,
  );
  for (const t of partnerTruncated) {
    console.warn(
      `[nj] ${t.date}: partner list has ${t.listed} trains, only the first ${maxPartnerTrains} kept — raise params.maxPartnerTrains`,
    );
  }
  const notTonight = [...trains]
    .filter(([, t]) => t.nextDate !== dates[0])
    .map(([n, t]) => `${n} (${t.nextDate})`);
  if (notTonight.length) {
    console.log(`[nj] not running tonight, kept from their next run: ${notTonight.join(", ")}`);
  }
  console.log(`[scrape] ${trains.size} NJ/EN trains listed`);

  const missingRoute = [];
  for (const [number, t] of trains) {
    const train = t.route;
    const fallbackPositions = (train?.stations ?? [])
      .filter((s) => s.location?.latitude && s.location?.longitude)
      .map((s) => [s.location.latitude, s.location.longitude]);
    const encodedPolyline =
      train?.polyline ||
      (fallbackPositions.length >= 2 ? polyline.encode(fallbackPositions) : null);
    if (!train || !encodedPolyline) {
      missingRoute.push(number);
      continue;
    }
    results[train.lineName || number] = {
      lineName: train.lineName || number,
      operator: train.operator,
      polyline: encodedPolyline,
      stations: train.stations,
    };
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
