// scripts/probe-sncf-open-data.mjs
// What the SNCF open-data pass sees, printed from where egress is open
// ("Probe SNCF open data" workflow; label a PR `run-probes`). The dev sandbox
// cannot reach ressources.data.sncf.com, so scripts/lib/sncf-open-data.mjs was
// written from SNCF's documented column labels. This prints, in order:
//   1. tariffs: the address that answered, the columns the reader resolved,
//      every distinct class / profile / carrier value (the classifier's verdict
//      beside each), and every row on one of our trains' origin–destination
//      pairs; then the fare the pass would write for each train;
//   2. punctuality: the columns, the latest month, every pair the AQST
//      selection covers (with the months it has), which of our pairs a daytime
//      Intercités also runs (from the live GTFS), and the figure the pass would
//      write for each train.
// Read-only. Run: node scripts/probe-sncf-open-data.mjs [outputDir] [--no-gtfs]

import fs from "node:fs";
import path from "node:path";
import { downloadGtfs, loadGtfsDir, dayServedStationPairs } from "./lib/gtfs.mjs";
import { fetchDataset } from "./lib/sncf-open-data-pass.mjs";
import {
  PUNCTUALITY_DATASET,
  TARIFFS_DATASET,
  classifyTariffClass,
  fareFromTariffs,
  isStandardAdultProfile,
  pairKey,
  punctualityForTrain,
  readPunctualityRows,
  readTariffRows,
  tariffRowsForTrain,
  trainEnds,
  uicKey,
} from "./lib/sncf-open-data.mjs";

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--")) ?? null;
const withGtfs = !args.includes("--no-gtfs");
const root = process.cwd();
const today = new Date().toISOString().slice(0, 10);
const json = (v) => JSON.stringify(v, null, 1);

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), body);
}

const registry = JSON.parse(fs.readFileSync(path.join(root, "data/sources/registry.json"), "utf8"));
const entry = (registry.sources ?? registry).find((e) => e.id === "sncf");
const base = entry?.params?.openData?.base;
const trainsFile = JSON.parse(fs.readFileSync(path.join(root, "public/data/scraped", entry.output), "utf8"));
const trains = trainsFile?.data?.trains ?? trainsFile?.trains ?? {};
console.log(`[probe] ${Object.keys(trains).length} SNCF trains in the committed ${entry.output}`);

const distinct = (rows, key) => {
  const counts = new Map();
  for (const r of rows) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

// ── 1. tariffs ──────────────────────────────────────────────────────────────
console.log(`\n=== tariffs (${TARIFFS_DATASET}) ===`);
const tariffs = await fetchDataset(entry.params.openData.tariffs || TARIFFS_DATASET, { base });
console.log(`answered by: ${tariffs.url ?? "nothing"}; modified ${tariffs.modified ?? "?"}`);
for (const e of tariffs.errors) console.log(`  tried: ${e}`);
if (tariffs.records.length) {
  save("tariffs-sample.json", json(tariffs.records.slice(0, 50)));
  console.log(`first record: ${json(tariffs.records[0])}`);
  const { rows, columns, unread } = readTariffRows(tariffs.records);
  console.log(`${tariffs.records.length} records, ${rows.length} read, ${unread} unread`);
  console.log(`columns: ${json(columns)}`);
  console.log("\nclasses (count · classifier verdict):");
  for (const [v, n] of distinct(rows, "classLabel")) console.log(`  ${n}\t${JSON.stringify(v)} → ${classifyTariffClass(v)}`);
  console.log("\nprofiles (count · standard adult?):");
  for (const [v, n] of distinct(rows, "profile")) console.log(`  ${n}\t${JSON.stringify(v)} → ${isStandardAdultProfile(v)}`);
  console.log("\ncarriers:");
  for (const [v, n] of distinct(rows, "carrier")) console.log(`  ${n}\t${JSON.stringify(v)}`);

  console.log("\nper train:");
  for (const [key, train] of Object.entries(trains)) {
    const ends = trainEnds(train);
    const { rows: matched, reversed } = tariffRowsForTrain(train, rows);
    console.log(`\n  ${key}: ${ends?.origin.name} (${ends?.origin.uic}) → ${ends?.destination.name} (${ends?.destination.uic})` +
      `, ${matched.length} row(s)${reversed ? " [reverse pair]" : ""}`);
    for (const r of matched) {
      console.log(`    ${r.classLabel} | ${r.profile} | ${r.min}–${r.max} → ${classifyTariffClass(r.classLabel, r.profile)}${isStandardAdultProfile(r.profile) ? "" : " (restricted)"}`);
    }
    const { fare, why } = fareFromTariffs(train, rows, { today, modified: tariffs.modified });
    console.log(`    → ${fare ? json(fare).replace(/\s+/g, " ") : `no fare: ${why}`}`);
  }
  // Pairs touching Paris-Austerlitz, in case our ends are spelled otherwise.
  const austerlitz = rows.filter((r) => r.originUic === "8754700" || r.destUic === "8754700");
  save("tariffs-austerlitz.json", json(austerlitz));
  console.log(`\n${austerlitz.length} tariff rows touch Paris-Austerlitz (saved to tariffs-austerlitz.json)`);
}

// ── 2. punctuality ──────────────────────────────────────────────────────────
console.log(`\n=== punctuality (${PUNCTUALITY_DATASET}) ===`);
const punct = await fetchDataset(entry.params.openData.punctuality || PUNCTUALITY_DATASET, { base });
console.log(`answered by: ${punct.url ?? "nothing"}; modified ${punct.modified ?? "?"}`);
for (const e of punct.errors) console.log(`  tried: ${e}`);
if (punct.records.length) {
  console.log(`first record: ${json(punct.records[0])}`);
  const { rows, columns, unread } = readPunctualityRows(punct.records);
  console.log(`${punct.records.length} records, ${rows.length} read, ${unread} unread`);
  console.log(`columns: ${json(columns)}`);
  const latest = rows.reduce((m, r) => (r.month > m ? r.month : m), "");
  console.log(`latest month: ${latest}`);
  const pairs = new Map();
  for (const r of rows) {
    const k = `${r.departure} → ${r.arrival}${r.axis ? ` [${r.axis}]` : ""}`;
    const p = pairs.get(k) ?? { months: 0, last: "" };
    p.months++;
    if (r.month > p.last) p.last = r.month;
    pairs.set(k, p);
  }
  console.log(`\n${pairs.size} pairs (months · last month):`);
  for (const [k, p] of [...pairs].sort()) console.log(`  ${p.months}\t${p.last}\t${k}`);

  let dayServedPairs = new Set();
  if (withGtfs) {
    const dir = path.join(root, "gtfs-data", "sncf-probe");
    await downloadGtfs(entry.params.feedUrl, dir);
    dayServedPairs = dayServedStationPairs(loadGtfsDir(dir), uicKey);
    console.log(`\nGTFS: ${dayServedPairs.size} station pairs have a daytime trip`);
  }
  console.log("\nper train:");
  for (const [key, train] of Object.entries(trains)) {
    const ends = trainEnds(train);
    const day = ends?.origin.uic && ends?.destination.uic && dayServedPairs.has(pairKey(ends.origin.uic, ends.destination.uic));
    const { value, why } = punctualityForTrain(train, rows, { dayServedPairs, today });
    console.log(`  ${key}: ${ends?.origin.name} → ${ends?.destination.name}${day ? " [day trains share this pair]" : ""}` +
      ` → ${value ? `${value.onTimeRate}% in ${value.month}, ${value.trailing.onTimeRate}% over ${value.trailing.months} months` : why}`);
  }
}
