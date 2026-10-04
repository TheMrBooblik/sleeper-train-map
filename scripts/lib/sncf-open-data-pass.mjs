// scripts/lib/sncf-open-data-pass.mjs
// The nightly pass that puts SNCF's own open data onto the trains the GTFS
// adapter just built: each Intercités de Nuit's fare range per couchette
// class (tarifs-intercites) and, where it can be attributed to the night
// train, its punctuality (regularite-mensuelle-intercites). The reading rules
// live in sncf-open-data.mjs; this file fetches, applies and logs.
//
// Never fatal. A dataset that cannot be fetched or read costs that dataset's
// facts, not the trains: last night's fares are carried for up to 30 days
// (carryPreviousFares) and last night's punctuality for up to 45 (the figure
// is monthly, so a missed night changes nothing).
//
// Driven by the registry entry's `params.openData`:
//   { base?: "https://ressources.data.sncf.com",
//     tariffs?: "tarifs-intercites" | false,
//     punctuality?: "regularite-mensuelle-intercites" | false }

import fs from "node:fs";
import path from "node:path";
import { carryPreviousFares, FARE_CARRY_MAX_DAYS } from "./fares.mjs";
import { dayServedStationPairs } from "./gtfs.mjs";
import {
  PUNCTUALITY_DATASET,
  SNCF_ODS_BASE,
  TARIFFS_DATASET,
  datasetModified,
  fareFromTariffs,
  odsExportUrls,
  odsMetadataUrl,
  punctualityForTrain,
  readPunctualityRows,
  readTariffRows,
  recordsFromPayload,
  uicKey,
} from "./sncf-open-data.mjs";

const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";
const TIMEOUT_MS = 90_000;
export const PUNCTUALITY_CARRY_MAX_DAYS = 45;

async function fetchBody(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/csv;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * A dataset's records from the first address that yields any, plus its
 * last-modified date when the metadata answers. { records, url, modified, errors }.
 */
export async function fetchDataset(dataset, { base = SNCF_ODS_BASE, fetchImpl = fetch } = {}) {
  const errors = [];
  let records = [];
  let used = null;
  for (const url of odsExportUrls(dataset, base)) {
    try {
      records = recordsFromPayload(await fetchBody(fetchImpl, url));
      if (records.length) {
        used = url;
        break;
      }
      errors.push(`${url}: no records`);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  let modified = null;
  if (used) {
    try {
      modified = datasetModified(JSON.parse(await fetchBody(fetchImpl, odsMetadataUrl(dataset, base))));
    } catch {
      // The date is a nicety; its absence costs nothing.
    }
  }
  return { records, url: used, modified, errors };
}

function readPreviousTrains(ctx, entry) {
  try {
    const file = path.join(ctx.rootDir, "public", "data", "scraped", entry.output);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.data?.trains ?? parsed?.trains ?? null;
  } catch {
    return null;
  }
}

/** Last night's punctuality onto a train that got none tonight, if recent. */
export function carryPreviousPunctuality(trains, previousTrains, { today, maxAgeDays = PUNCTUALITY_CARRY_MAX_DAYS } = {}) {
  if (!previousTrains) return 0;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  let carried = 0;
  for (const [key, train] of Object.entries(trains ?? {})) {
    if (train.punctuality) continue;
    const prev = previousTrains[key]?.punctuality;
    const sampledMs = Date.parse(`${prev?.sampledAt}T00:00:00Z`);
    if (!prev || !Number.isFinite(sampledMs) || !Number.isFinite(todayMs)) continue;
    if ((todayMs - sampledMs) / 86_400_000 > maxAgeDays) continue;
    train.punctuality = prev;
    carried++;
  }
  return carried;
}

/**
 * Apply both datasets to `trains` in place. `gtfs` is the feed the adapter
 * loaded (for the day-service gate); without it no punctuality is attributed.
 * Returns a summary for the log and the tests.
 */
export async function runSncfOpenDataPass(trains, { entry, ctx, gtfs = null, log = console.log, fetchImpl = fetch }) {
  const cfg = entry?.params?.openData ?? {};
  const base = cfg.base || SNCF_ODS_BASE;
  const today = ctx.today;
  const previous = readPreviousTrains(ctx, entry);
  const summary = { priced: 0, carriedFares: 0, punctual: 0, carriedPunctuality: 0, misses: {} };

  // ── Fares ────────────────────────────────────────────────────────────────
  const tariffsId = cfg.tariffs === false ? null : cfg.tariffs || TARIFFS_DATASET;
  if (tariffsId) {
    try {
      const got = await fetchDataset(tariffsId, { base, fetchImpl });
      if (!got.records.length) throw new Error(got.errors.join("; ") || "no records");
      const { rows, columns, unread } = readTariffRows(got.records);
      log(
        `tariffs: ${got.records.length} records from ${got.url}` +
          (got.modified ? ` (modified ${got.modified})` : "") +
          `, ${rows.length} read, ${unread} unread; columns ${JSON.stringify(columns)}`,
      );
      const classLabels = new Set();
      for (const [key, train] of Object.entries(trains)) {
        const { fare, why } = fareFromTariffs(train, rows, { today, modified: got.modified });
        if (fare) {
          train.fare = fare;
          summary.priced++;
          if (why) log(`tariffs: ${key} ${why}`);
          for (const c of Object.keys(fare.classes)) classLabels.add(c);
        } else {
          summary.misses[key] = why;
          log(`tariffs: ${key} not priced — ${why}`);
        }
      }
      log(`tariffs: priced ${summary.priced}/${Object.keys(trains).length} (classes: ${[...classLabels].join(", ") || "none"})`);
    } catch (err) {
      log(`tariffs: dataset unavailable tonight — ${err.message}`);
    }
    summary.carriedFares = carryPreviousFares(trains, previous, { today, maxAgeDays: FARE_CARRY_MAX_DAYS });
    if (summary.carriedFares) log(`tariffs: carried ${summary.carriedFares} fare(s) from a previous run`);
  }

  // ── Punctuality ──────────────────────────────────────────────────────────
  const punctualityId = cfg.punctuality === false ? null : cfg.punctuality || PUNCTUALITY_DATASET;
  if (punctualityId) {
    try {
      if (!gtfs) throw new Error("no GTFS feed to tell night pairs from day pairs");
      const got = await fetchDataset(punctualityId, { base, fetchImpl });
      if (!got.records.length) throw new Error(got.errors.join("; ") || "no records");
      const { rows, columns, unread } = readPunctualityRows(got.records);
      log(
        `punctuality: ${got.records.length} records from ${got.url}, ${rows.length} read, ` +
          `${unread} unread; columns ${JSON.stringify(columns)}`,
      );
      const dayServedPairs = dayServedStationPairs(gtfs, uicKey);
      for (const [key, train] of Object.entries(trains)) {
        const { value, why } = punctualityForTrain(train, rows, { dayServedPairs, today });
        if (value) {
          train.punctuality = value;
          summary.punctual++;
          log(`punctuality: ${key} ${value.onTimeRate}% on time in ${value.month} (${value.trailing.onTimeRate}% over ${value.trailing.months} months)`);
        } else {
          log(`punctuality: ${key} none — ${why}`);
        }
      }
    } catch (err) {
      log(`punctuality: unavailable tonight — ${err.message}`);
    }
    summary.carriedPunctuality = carryPreviousPunctuality(trains, previous, { today });
    if (summary.carriedPunctuality) log(`punctuality: carried ${summary.carriedPunctuality} from a previous run`);
  }

  return summary;
}
