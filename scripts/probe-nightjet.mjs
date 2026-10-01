#!/usr/bin/env node
// scripts/probe-nightjet.mjs
// Everything nightjet.com lists, against what the scrape finds and what it has
// committed.
//
// The dev sandbox cannot reach nightjet.com, so this runs from Actions (label a
// PR `run-probes`, or dispatch "Probe NightJet source"). Two discoveries:
//
//   SCRAPE  exactly what tonight's scrape runs — the registry's seed countries,
//           its discovery window, its look-ahead rule.
//   WIDE    a deliberately wasteful search the scrape cannot afford nightly:
//           ten more UIC codes on top of everything SCRAPE learned, and dates
//           out to four months, every one walked.
//
// A train WIDE lists and SCRAPE does not is a train the adapter would still
// miss, which is the finding this exists for; it also says whether it falls
// beyond the window (a future timetable) or behind a country nothing else
// reaches. The diff against the committed nightjet-trains.json is printed last
// so a log tail carries it.
//
// Read-only: GET requests only, nothing committed. Writes a JSON report to the
// directory given as the first argument (default probe-output/).
//
// Usage: node scripts/probe-nightjet.mjs [outDir]
//   NJ_PROBE_OFFSETS=0,7,30,60,120   day offsets WIDE walks (default)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTrains, discoveryDates } from "./adapters/nightjet.mjs";
import { fetchWithTimeout } from "./lib/scrape-helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] || "probe-output");
fs.mkdirSync(outDir, { recursive: true });

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
const params = registry.find((e) => e.id === "nightjet").params;
// UIC codes the network could plausibly reach that nothing may mention yet.
const EXTRA_CODES = ["51", "52", "53", "54", "55", "56", "72", "78", "79", "87", "22", "74", "86"];

const committed = JSON.parse(
  fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"),
).data.trains;

const today = new Date().toISOString().slice(0, 10);
const offsets = String(process.env.NJ_PROBE_OFFSETS || "0,7,30,60,120")
  .split(",")
  .map(Number)
  .filter(Number.isFinite);
const wideDates = [...new Set(offsets.map((o) => discoveryDates(today, o + 1).at(-1)))];

const describe = (t) =>
  t?.route
    ? `${t.route.stations[0]?.name} → ${t.route.stations.at(-1)?.name} (${t.route.stations.length} stops)`
    : "no route returned";

// ─── SCRAPE ─────────────────────────────────────────────────────────────────
console.log(`[probe:nj] SCRAPE: seed ${params.countryCodes.join(",")}, window ${params.discoveryDays} day(s)`);
const scrape = await discoverTrains({
  seedCodes: params.countryCodes,
  dates: discoveryDates(today, params.discoveryDays ?? 7),
  maxPartnerTrains: params.maxPartnerTrains ?? Infinity,
  concurrency: params.concurrency ?? 12,
});
for (const d of scrape.perDate) {
  console.log(
    `  ${d.date}: +${d.newTrains} train(s), ${d.countryRequests} pair request(s)` +
      `${d.countryFailed ? ` (${d.countryFailed} failed)` : ""}, ${d.countries} countries, partner ${d.partnerOk ? d.partner : "n/a"}`,
  );
}
console.log(`  countries: ${scrape.countries.join(", ")}`);
console.log(
  `  look-ahead: ${scrape.lookAhead ? "YES — the country search answers with each train's next run" : "no — the country search lists only the date asked"}`,
);
console.log(`  trains: ${scrape.trains.size}`);

// ─── WIDE ───────────────────────────────────────────────────────────────────
const wideSeed = [...new Set([...scrape.countries, ...EXTRA_CODES])];
console.log(`\n[probe:nj] WIDE: ${wideSeed.length} countries, dates ${wideDates.join(", ")}`);
const wide = await discoverTrains({
  seedCodes: wideSeed,
  dates: wideDates,
  concurrency: params.concurrency ?? 12,
  stopOnLookAhead: false,
});
for (const d of wide.perDate) {
  console.log(
    `  ${d.date}: +${d.newTrains} train(s), ${d.countryRequests} pair request(s)` +
      `${d.countryFailed ? ` (${d.countryFailed} failed)` : ""}, ${d.countries} countries, partner ${d.partnerOk ? d.partner : "n/a"}`,
  );
}
const silentCodes = EXTRA_CODES.filter((c) => !scrape.countries.includes(c));
console.log(`  extra codes no SCRAPE answer mentioned: ${silentCodes.join(", ") || "none"}`);

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
const raw = {};
for (const p of [
  `destinations/partner/${today}`,
  `destinations/country/85/country/78/${today}`,
  `destinations/country/88/country/81/${today}`,
  `destinations/countries/${today}`,
  `destinations/trains/${today}`,
  `destinations/stations/${today}`,
]) {
  raw[p] = await snippet(`https://www.nightjet.com/nj-booking-ocp/${p}`);
}
console.log("\n[probe:nj] endpoints:");
for (const [k, v] of Object.entries(raw)) {
  console.log(`  ${k.padEnd(48)} ${v.error ? `error ${v.error}` : `${v.status}, ${v.bytes} bytes`}`);
}

// ─── The diff ───────────────────────────────────────────────────────────────
const all = new Map([...wide.trains, ...scrape.trains]);
const missedByScrape = [...wide.trains.keys()].filter((n) => !scrape.trains.has(n)).sort();
const notCommitted = [...all.keys()].filter((n) => !committed[n]).sort();
const stale = Object.keys(committed).filter((n) => !all.has(n)).sort();

console.log(`\nWIDE LISTS, TONIGHT'S SCRAPE WOULD NOT FIND (${missedByScrape.length}):`);
for (const n of missedByScrape) {
  const t = wide.trains.get(n);
  console.log(`  ${n.padEnd(10)} next run ${t.nextDate} — ${describe(t)}`);
}
console.log(`\nLISTED BY nightjet.com, NOT IN THE COMMITTED FILE (${notCommitted.length}):`);
for (const n of notCommitted) {
  const t = all.get(n);
  const by = scrape.trains.has(n) ? "the new scrape finds it" : "only WIDE finds it";
  console.log(`  ${n.padEnd(10)} next run ${t.nextDate}, ${by} — ${describe(t)}`);
}
console.log(`\nCOMMITTED, NOT LISTED ON ANY PROBED DATE (${stale.length}): ${stale.join(", ") || "none"}`);

const asJson = (m) =>
  Object.fromEntries(
    [...m].map(([n, t]) => [n, { nextDate: t.nextDate, listedOn: t.listedOn, partnerTrain: t.partnerTrain, route: describe(t) }]),
  );
fs.writeFileSync(
  path.join(outDir, "nightjet-probe.json"),
  JSON.stringify(
    {
      today,
      scrape: { countries: scrape.countries, lookAhead: scrape.lookAhead, perDate: scrape.perDate, trains: asJson(scrape.trains) },
      wide: { countries: wide.countries, perDate: wide.perDate, trains: asJson(wide.trains) },
      missedByScrape,
      notCommitted,
      stale,
      raw,
    },
    null,
    2,
  ),
);
console.log(`\n[probe:nj] report: ${path.join(outDir, "nightjet-probe.json")}`);
