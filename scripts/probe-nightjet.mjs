#!/usr/bin/env node
// scripts/probe-nightjet.mjs
// Everything nightjet.com lists, against what the scrape has committed.
//
// The dev sandbox cannot reach nightjet.com, so this runs from Actions (label a
// PR `run-probes`, or dispatch "Probe NightJet source"). It answers the three
// questions behind "does the map miss a train":
//
//   1. Over the next weeks, which trains does the API list that the committed
//      nightjet-trains.json does not carry, and on which dates? A train listed
//      only beyond the adapter's discovery window is printed as such.
//   2. Do country codes beyond the registry's six (Czechia, Hungary, Poland,
//      Croatia, Slovenia, …) list any train the six do not? Each extra code is
//      paired with every code, both ways.
//   3. What do the endpoints actually return — the partner list's full length
//      (the adapter used to keep 25), one raw country answer, and the status of
//      a few list endpoints the booking site might expose.
//
// Read-only: GET requests only, nothing committed. Writes a JSON report to the
// directory given as the first argument (default probe-output/).
//
// Usage: node scripts/probe-nightjet.mjs [outDir]
//   NJ_PROBE_DAYS=21       consecutive dates from today (default 21)
//   NJ_PROBE_SAMPLES=30,60,90,120   extra day offsets sampled further out

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoveryDates,
  fetchCountryTrains,
  fetchPartnerTrains,
  fetchSingleTrain,
} from "./adapters/nightjet.mjs";
import { fetchWithTimeout } from "./lib/scrape-helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] || "probe-output");
fs.mkdirSync(outDir, { recursive: true });

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
const entry = registry.find((e) => e.id === "nightjet");
const CODES = entry.params.countryCodes;
const WINDOW = entry.params.discoveryDays ?? 7;
// UIC country codes the network reaches beyond the registry's six.
const EXTRA_CODES = [51, 53, 54, 55, 56, 72, 78, 79, 87, 22];

const committed = JSON.parse(
  fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"),
).data.trains;

const today = new Date().toISOString().slice(0, 10);
const days = Number(process.env.NJ_PROBE_DAYS || 21);
const samples = String(process.env.NJ_PROBE_SAMPLES || "30,60,90,120")
  .split(",")
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= days);
const dates = [
  ...discoveryDates(today, days),
  ...samples.map((off) => discoveryDates(today, off + 1).at(-1)),
];

const report = { today, codes: CODES, window: WINDOW, dates: [], trains: {}, extraCodes: {}, raw: {} };
const seen = new Map(); // train -> { dates: [], via: Set }
const note = (n, date, via) => {
  if (!seen.has(n)) seen.set(n, { dates: [], via: new Set() });
  const s = seen.get(n);
  if (!s.dates.includes(date)) s.dates.push(date);
  s.via.add(via);
};

console.log(`[probe:nj] ${dates.length} dates, codes ${CODES.join(",")}, adapter window ${WINDOW} day(s)\n`);
for (const date of dates) {
  const [country, partner] = await Promise.all([
    fetchCountryTrains(date, CODES),
    fetchPartnerTrains(date),
  ]);
  country.numbers.forEach((n) => note(n, date, "country"));
  partner.numbers.forEach((n) => note(n, date, "partner"));
  report.dates.push({ date, country: country.numbers.length, countryFailed: country.failed, partner: partner.numbers.length, partnerOk: partner.ok });
  console.log(
    `${date}  country ${String(country.numbers.length).padStart(3)}${country.failed ? ` (${country.failed}/${country.pairs} failed)` : ""}` +
      `  partner ${partner.ok ? String(partner.numbers.length).padStart(3) : "n/a"}`,
  );
}

// ─── Extra country codes ────────────────────────────────────────────────────
console.log(`\n[probe:nj] extra country codes on ${dates[0]} and ${dates[3]}:`);
for (const date of [dates[0], dates[3]]) {
  for (const extra of EXTRA_CODES) {
    const found = new Set();
    let ok = 0;
    for (const other of [...CODES, ...EXTRA_CODES]) {
      for (const [from, to] of [[extra, other], [other, extra]]) {
        const url = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from}/country/${to}/${date}`;
        try {
          const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
          if (!res.ok) continue;
          ok++;
          const body = await res.json();
          (Array.isArray(body) ? body : []).forEach((t) => t?.trainNumber && found.add(t.trainNumber));
        } catch {
          /* counted as not ok */
        }
      }
    }
    const fresh = [...found].filter((n) => !seen.has(n));
    fresh.forEach((n) => note(n, date, `code ${extra}`));
    report.extraCodes[`${extra}@${date}`] = { okRequests: ok, trains: [...found], notFoundByRegistryCodes: fresh };
    console.log(
      `  ${date} code ${String(extra).padEnd(3)} ${String(ok).padStart(3)} ok request(s), ${found.size} train(s)` +
        (fresh.length ? `, NEW: ${fresh.join(", ")}` : ""),
    );
  }
}

// ─── Raw shapes and candidate list endpoints ────────────────────────────────
const snippet = async (url) => {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    return { status: res.status, bytes: text.length, head: text.slice(0, 1500) };
  } catch (e) {
    return { error: e.message };
  }
};
report.raw.partner = await snippet(`https://www.nightjet.com/nj-booking-ocp/destinations/partner/${today}`);
report.raw.countryAtDe = await snippet(`https://www.nightjet.com/nj-booking-ocp/destinations/country/81/country/80/${today}`);
for (const p of [
  `destinations/countries/${today}`,
  `destinations/country/${today}`,
  `destinations/trains/${today}`,
  `destinations/stations/${today}`,
  `destinations/${today}`,
  `stations/find?lang=de&country=at&name=Wien`,
]) {
  report.raw[p] = await snippet(`https://www.nightjet.com/nj-booking-ocp/${p}`);
}
console.log("\n[probe:nj] endpoints:");
for (const [k, v] of Object.entries(report.raw)) {
  console.log(`  ${k.padEnd(48)} ${v.error ? `error ${v.error}` : `${v.status}, ${v.bytes} bytes`}`);
}

// ─── The diff ───────────────────────────────────────────────────────────────
const windowDates = new Set(dates.slice(0, WINDOW));
for (const [n, s] of seen) {
  report.trains[n] = { dates: s.dates, via: [...s.via], committed: !!committed[n], inAdapterWindow: s.dates.some((d) => windowDates.has(d)) };
}
const missing = [...seen.keys()].filter((n) => !committed[n]).sort();
const stale = Object.keys(committed).filter((n) => !seen.has(n)).sort();

// What a missing train actually is, so the log says which route the map lacks.
const describe = async (n) => {
  const date = seen.get(n).dates[0];
  const t = await fetchSingleTrain(n, date);
  return t ? `${t.stations[0]?.name} → ${t.stations.at(-1)?.name} (${t.stations.length} stops, on ${date})` : `no route on ${date}`;
};

console.log(`\n[probe:nj] ${seen.size} train(s) listed in total; ${Object.keys(committed).length} committed.`);
console.log(`\nLISTED BY nightjet.com BUT NOT COMMITTED (${missing.length}):`);
for (const n of missing) {
  const r = report.trains[n];
  r.route = await describe(n);
  console.log(
    `  ${n.padEnd(10)} ${r.inAdapterWindow ? "in window " : "LATER     "} first ${r.dates[0]}, ${r.dates.length} date(s), via ${r.via.join("+")} — ${r.route}`,
  );
}
console.log(`\nCOMMITTED BUT NOT LISTED ON ANY PROBED DATE (${stale.length}): ${stale.join(", ") || "none"}`);

fs.writeFileSync(path.join(outDir, "nightjet-probe.json"), JSON.stringify(report, null, 2));
console.log(`\n[probe:nj] report: ${path.join(outDir, "nightjet-probe.json")}`);
