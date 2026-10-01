// scripts/probe-es-fares.mjs
// What the European Sleeper fare pass sees, printed from where egress is open
// ("Probe European Sleeper fares" workflow; label a PR `run-probes`). The dev
// sandbox cannot reach the booking API or www.europeansleeper.eu, so
// scripts/lib/es-fares.mjs was written from the operator's OpenAPI notes and
// scripts/lib/es-last-minute.mjs without ever seeing a landing page. This
// prints, in order:
//   1. /constants: reservation horizon, routes, and our trains' station ids;
//   2. per train, one /search/trains and one /search/availability answer
//      (raw, capped) and what the reader makes of them;
//   3. the last-minute index and each landing page: what the parser dated,
//      every form field and option on the page, a few /receipt/price
//      answers — and the page's visible text LAST, so a log tail carries it.
// Read-only: searches and GETs, no booking is created.
// Run: node scripts/probe-es-fares.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import {
  classesFromAvailability,
  constantsStations,
  fetchConstants,
  nightsFromTrainSearch,
  searchAvailability,
  searchTrains,
} from "./lib/es-fares.mjs";
import {
  findDealIds,
  findLandingPaths,
  findOfferLinks,
  parseEuroAmount,
  parseLastMinutePage,
  saleEndDate,
  trainForOfferText,
} from "./lib/es-last-minute.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";
import { constantsRoutes, endpointsFor } from "./lib/es-fare-calendar.mjs";

const SITE = "https://www.europeansleeper.eu";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";
const outDir = process.argv[2] ?? null;
const root = process.cwd();
const today = new Date().toISOString().slice(0, 10);
const plus = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const cap = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);
const json = (v) => JSON.stringify(v, null, 1);

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), body);
}

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  } catch {
    return null;
  }
};

const registry = readJson("data/sources/registry.json") ?? [];
const entry = registry.find((e) => e.id === "europeansleeper");
const cfg = entry?.params?.fares ?? {};
const file = readJson(`public/data/scraped/${entry?.output ?? "europeansleeper-trains.json"}`);
const trains = file?.data?.trains ?? file?.trains ?? {};
const curated = readJson("data/overrides/operator-booking.json")?.ES?.stationNames ?? {};

console.log(`\n=== 1. /constants (${today}) ===`);
let stations = [];
let routes = [];
try {
  const constants = await fetchConstants();
  routes = constantsRoutes(constants);
  save("constants.json", json(constants));
  stations = constantsStations(constants);
  console.log(`settings: ${json(constants?.settings ?? null)}`);
  console.log(`${stations.length} stations; routes:`);
  for (const r of constants?.routes ?? []) {
    console.log(`  ${r.id}  ${String(r.from).slice(0, 10)} → ${r.until ? String(r.until).slice(0, 10) : "open"}  ${(r.stations ?? []).map((s) => s.id + (s.mappedStationId ? `→${s.mappedStationId}` : "")).join(" ")}`);
  }
  console.log(`station names: ${stations.map((s) => `${s.id}=${s.name}`).join(" | ")}`);
} catch (err) {
  console.log(`FAILED: ${err.message} ${err.body ?? ""}`);
}

console.log(`\n=== 2. per-train search + availability ===`);
// The same endpoint rule the nightly pass uses (same-city operator terminus
// where an end is not sold), so the probe searches what the scrape searches.
const endpoints = endpointsFor(trains, { curated, stations, routes, log: (m) => console.log(m) });
for (const [key, train] of Object.entries(trains)) {
  const ep = endpoints[key];
  console.log(`\n--- ${key}: ${train.stations?.[0]?.name} → ${train.stations?.[train.stations.length - 1]?.name}: ${ep ? `${ep.from} (${ep.fromId}) → ${ep.to} (${ep.toId})` : "not priced"} ---`);
  if (!ep) continue;
  const { fromId, toId } = ep;
  for (const offset of [10, 25]) {
    const date = plus(offset);
    try {
      const body = await searchTrains({ fromId, toId, date });
      save(`search-${key}-${date}.json`, json(body));
      console.log(`search/trains ${date}: ${cap(json(body), 2500)}`);
      const nights = nightsFromTrainSearch(body, key);
      console.log(`read as: ${json(Object.fromEntries(Object.entries(nights).map(([d, v]) => [d, v ? { routeId: v.routeId, bookable: v.trip?.bookable, priceFrom: v.trip?.priceFrom } : null])))}`);
      const hit = Object.entries(nights).find(([, v]) => v?.routeId);
      if (!hit) continue;
      const availability = await searchAvailability({ routeId: hit[1].routeId, fromId, toId, trainNumber: key, date: hit[0] });
      save(`availability-${key}-${hit[0]}.json`, json(availability));
      console.log(`availability ${hit[0]}: ${cap(json(availability), 5000)}`);
      console.log(`read as: ${json(classesFromAvailability(availability))}`);
      break;
    } catch (err) {
      console.log(`FAILED ${date}: ${err.message} ${err.body ?? ""}`);
    }
  }
}

async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, redirect: "follow" });
    return { status: res.status, body: await res.text(), url: res.url };
  } catch (err) {
    return { status: null, body: "", error: err.message };
  }
}

const visibleText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/td|\/option|\/label)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/** Every form, input, select and option, and any element with a data-* that looks like a deal. */
function formDigest(html) {
  const lines = [];
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) lines.push(m[0]);
  for (const m of html.matchAll(/<(input|select|button|textarea)\b[^>]*>/gi)) lines.push(m[0]);
  for (const m of html.matchAll(/<option\b[^>]*>[^<]{0,120}/gi)) lines.push(m[0].replace(/\s+/g, " "));
  for (const m of html.matchAll(/<[a-z]+\b[^>]*\bdata-[a-z-]*(?:price|deal|date|trip|train)[a-z-]*=[^>]*>/gi)) lines.push(m[0]);
  for (const m of html.matchAll(/<script\b[^>]*src=[^>]*>/gi)) lines.push(m[0]);
  for (const m of html.matchAll(/(?:fetch|axios|ajax|\$\.get|\$\.post)\s*\(\s*["'`][^"'`]+/gi)) lines.push(`JS call: ${m[0]}`);
  for (const m of html.matchAll(/["'`](\/(?:api|receipt|deals?|last)[^"'`\s]*)["'`]/gi)) lines.push(`path: ${m[1]}`);
  return [...new Set(lines)];
}

console.log(`\n=== 3. last-minute pages ===`);
const index = await get(`${SITE}${cfg.lastMinute?.indexPath ?? "/last-minute"}`);
save("last-minute-index.html", index.body);
const discovered = findLandingPaths(index.body);
console.log(`index: HTTP ${index.status} ${index.error ?? ""} (${index.body.length} bytes) → ${discovered.join(", ") || "no landing links found"}`);
// The flash sale is an index of per-direction offer pages, like /last-minute
// (2026-10-01): read the index, then every page it links, with the train each
// link's text names — the same attribution the nightly pass makes.
const flashIndexPath = cfg.flashSale?.indexPath ?? "/flash-sale";
const flashIndex = await get(`${SITE}${flashIndexPath}`);
save("flash-sale-index.html", flashIndex.body);
const trainCities = Object.fromEntries(
  Object.entries(trains).map(([k, t]) => [
    k,
    [t.stations?.[0]?.name, t.stations?.[t.stations.length - 1]?.name].map((n) => cityForStation(n ?? "") || n || ""),
  ]),
);
const flashLinks = findOfferLinks(flashIndex.body, { pathPattern: /flash/i, indexPath: flashIndexPath });
console.log(
  `flash index: HTTP ${flashIndex.status} ${flashIndex.error ?? ""} (${flashIndex.body.length} bytes); sale ends ${saleEndDate(flashIndex.body, { today }) ?? "?"}`,
);
for (const l of flashLinks) console.log(`  ${l.path}  "${l.text}" → ES ${trainForOfferText(l.text, trainCities) ?? "?"}`);
const paths = [
  ...new Set([
    ...flashLinks.map((l) => l.path),
    ...(cfg.lastMinute?.pages ?? []).map((p) => p.path),
    ...discovered,
  ]),
];
const texts = [];
for (const p of paths) {
  const page = await get(`${SITE}${p}`);
  save(`page${p.replace(/\//g, "_")}.html`, page.body);
  console.log(`\n--- ${p}: HTTP ${page.status} ${page.error ?? ""} ${page.url && page.url !== `${SITE}${p}` ? `(→ ${page.url})` : ""} ${page.body.length} bytes ---`);
  const parsed = parseLastMinutePage(page.body, { today, trainNumbers: Object.keys(trains) });
  console.log(`parser: ${parsed.ids} id(s), ${parsed.deals.length} dated, undated: ${parsed.undated.join(", ") || "none"}`);
  for (const d of parsed.deals) console.log(`  deal ${d.id}: ${d.date} ${d.amount ?? "?"} ${d.kind ?? "?"} train=${d.trainNumber ?? "?"}`);
  const ids = findDealIds(page.body).slice(0, 5);
  for (const { id, own } of ids) {
    const r = await get(`${SITE}/receipt/price/1/${id}`);
    console.log(`  /receipt/price/1/${id}: HTTP ${r.status} "${cap(r.body.trim(), 80)}" → ${parseEuroAmount(r.body)} | own text: "${cap(own, 120)}"`);
  }
  // The markup around each deal button, raw: which tab/section/route heading
  // a deal sits under is what attributes it to a train, and the visible text
  // alone does not show the nesting.
  if (/flash/.test(p) && p === paths[0]) {
    for (const m of [...page.body.matchAll(/<button\b[^>]*name=["']price["'][^>]*>/gi)].slice(0, 12)) {
      const at = m.index;
      console.log(`  --- raw around price button @${at} ---`);
      console.log(cap(page.body.slice(Math.max(0, at - 1500), at + 400).replace(/\s+/g, " "), 2200));
    }
    for (const m of [...page.body.matchAll(/<(?:div|section|button|a|li)\b[^>]*(?:tab|route|panel)[^>]*>/gi)].slice(0, 40)) {
      console.log(`  tabish: ${cap(m[0], 240)}`);
    }
  }
  console.log("form digest:");
  for (const line of formDigest(page.body).slice(0, 150)) console.log(`  ${cap(line, 300)}`);
  texts.push([p, visibleText(page.body)]);
}

console.log(`\n=== 4. landing page text (last, for the log tail) ===`);
for (const [p, text] of texts) console.log(`\n--- ${p} ---\n${cap(text, 6000)}`);
