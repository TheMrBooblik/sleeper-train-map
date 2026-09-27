// scripts/adapters/viaggiatreno.mjs
// Trenitalia Intercity Notte (ICN) via the public Viaggiatreno API. The train
// numbers to query live in the registry entry params (data, not code).

import polyline from "@mapbox/polyline";
import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout, titleCase } from "../lib/scrape-helpers.mjs";
import { romeClock, searchTimeBefore, searchTrainFare } from "../lib/lefrecce.mjs";
import { carryPreviousFares, FARE_CARRY_MAX_DAYS } from "../lib/fares.mjs";

// Fares: sample a night this far ahead (yield-managed, so a date inside the
// usual booking window is what a traveller would actually see), trying the
// next few nights when the train does not run on the first.
const FARE_SAMPLE_DAYS_AHEAD = 21;
const FARE_SAMPLE_TRIES = 4;
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

function isoPlusDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One train's fare from lefrecce.it, the operator's own booking backend, for
 * the whole journey (first to last station). Never throws: a failed or empty
 * search costs the price, not the train. Exported for tests.
 */
export async function fetchIcnFare(train, { today, fetchImpl = fetch, log = console.log } = {}) {
  const trainNumber = String(train.lineName ?? "").replace(/\D/g, "");
  const first = train.stations?.[0];
  const last = train.stations?.[train.stations.length - 1];
  const clock = romeClock(first?.departure);
  if (!trainNumber || !first?.code || !last?.code || !clock) {
    log(`[icn-fare] ${train.lineName}: no station codes/departure to search with`);
    return null;
  }
  const time = searchTimeBefore(clock);
  for (let i = 0; i < FARE_SAMPLE_TRIES; i++) {
    const date = isoPlusDays(today, FARE_SAMPLE_DAYS_AHEAD + i);
    try {
      const { fare, solutions } = await searchTrainFare(
        { fromCode: first.code, toCode: last.code, date, time, trainNumber },
        { fetchImpl },
      );
      if (fare) {
        log(
          `[icn-fare] ${train.lineName} ${date}: from €${fare.fromPrice} (${fare.seatClass ?? "no class"}) ${JSON.stringify(fare.classes)}`,
        );
        return { ...fare, sampledAt: today, travelDate: date };
      }
      log(`[icn-fare] ${train.lineName} ${date}: not among ${solutions} solution(s)`);
    } catch (err) {
      log(`[icn-fare] ${train.lineName} ${date}: ${err.message}`);
      return null; // transport/shape error: another date will not fix it
    } finally {
      await sleep(FARE_REQUEST_SPACING_MS);
    }
  }
  return null;
}

export async function run(entry, ctx) {
  const { trainNumbers = [], concurrency = 4 } = entry.params ?? {};
  const trains = await buildItalianTrains(trainNumbers, concurrency);

  let fetched = 0;
  for (const train of Object.values(trains)) {
    const fare = await fetchIcnFare(train, { today: ctx.today, fetchImpl: ctx.fetch ?? fetch });
    if (fare) {
      train.fare = fare;
      fetched++;
    }
  }
  let previous = null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(ctx.rootDir, "public", "data", "scraped", entry.output), "utf8"),
    );
    previous = raw?.data?.trains ?? raw?.trains ?? null;
  } catch {
    /* first run, or unreadable: nothing to carry */
  }
  const carried = carryPreviousFares(trains, previous, {
    today: ctx.today,
    maxAgeDays: FARE_CARRY_MAX_DAYS,
  });
  console.log(
    `[scrape] italian: fares for ${Object.values(trains).filter((t) => t.fare).length}/${Object.keys(trains).length} trains ` +
      `(${fetched} fetched tonight, ${carried} carried)`,
  );

  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  console.log(`[scrape] stored ${Object.keys(trains).length} Italian ICN trains`);
}
