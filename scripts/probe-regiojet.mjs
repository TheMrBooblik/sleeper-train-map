#!/usr/bin/env node
// scripts/probe-regiojet.mjs
// What RegioJet's two GTFS feeds and its public booking API answer an
// automated client — run where egress is open (label a PR `run-probes`); the
// dev sandbox reaches neither ybus.sa.cz nor brn-ybus-pubapi.sa.cz.
//
//   1. Both feeds (registry params.feeds): size, routes, every rail trip
//      crossing midnight, and the night trains the adapter builds from them.
//   2. GET /consts/seatClasses: every seat class with what classifySeatClass
//      reads it as.
//   3. Per night train, a week out: the search between its two ends (every
//      connection that day), the one matched as ours, the connection's raw
//      answer and the berth prices read from it.
//
// Writes the raw answers to <outDir> (default probe-output/) for fixtures.
// Read-only: a few dozen GETs, the honest User-Agent, nothing committed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeed } from "./adapters/regiojet-gtfs.mjs";
import { buildRegiojetTrains, makeStationNamer, mergeFeeds, nightRuns } from "./lib/regiojet.mjs";
import {
  SEAT_CLASSES_URL,
  berthClasses,
  buildRouteUrl,
  buildSearchUrl,
  classifySeatClass,
  fetchRjJson,
  findTrainRoute,
  pricingEnds,
  seatClassMap,
} from "./lib/rj-fares.mjs";
import STATION_ALIASES from "../data/overrides/station-aliases.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.argv[2] ?? "probe-output");
fs.mkdirSync(outDir, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(outDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
const registry = JSON.parse(fs.readFileSync(path.join(root, "data/sources/registry.json"), "utf8"));
const entry = registry.find((e) => e.id === "regiojet");
const config = JSON.parse(fs.readFileSync(path.join(root, entry.params.configPath), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const travelDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const section = (t) => console.log(`\n=== ${t} ===`);

section("1. GTFS feeds");
const loaded = [];
for (const f of entry.params.feeds) {
  try {
    const tables = await loadFeed({ url: f.url, log: (m) => console.log(`${f.id}: ${m}`) });
    console.log(`${f.id}: ${tables.routes.length} routes, ${tables.trips.length} trips, ${tables.stopTimes.length} stop times, ${tables.calendar.length} calendar rows, ${tables.calendarDates.length} exceptions, ${tables.shapes.length} shape points`);
    for (const r of tables.routes) console.log(`  route ${r.route_id} type ${r.route_type} ${r.route_short_name} ${r.route_long_name}`);
    loaded.push({ id: f.id, tables });
  } catch (err) {
    console.log(`${f.id}: ${f.url} — ${err.message}`);
  }
}
const feed = loaded.length ? mergeFeeds(loaded) : null;
if (!feed) {
  console.log("no feed read — stopping");
  process.exit(0);
}
const botStops = JSON.parse(fs.readFileSync(path.join(root, "public/data/scraped/backontrack-stops.json"), "utf8"));
const nameStop = makeStationNamer({
  stops: Object.values(botStops.data ?? botStops),
  resolveAlias: (n) => STATION_ALIASES[String(n).toLowerCase().trim()] ?? n,
  stationNames: config.stationNames,
});
const { byNumber } = nightRuns(feed, { ...config, minMinutes: 0, minDepartureHour: 0 }, nameStop);
console.log("\nrail trips crossing midnight (any length, any departure):");
for (const [n, runs] of byNumber) {
  for (const r of runs) {
    const a = r.stops[0];
    const b = r.stops.at(-1);
    console.log(`  ${r.lineName} [${r.feed}] ${a.feedName} ${a.departure} → ${b.feedName} ${b.arrival}, ${r.stops.length} stops, ${r.dates.size} date(s)`);
  }
}
const trains = buildRegiojetTrains({ config, feed, nameStop, today, log: (m) => console.log(`  ${m}`) });
console.log("\nnight trains built:");
for (const t of Object.values(trains)) {
  console.log(`  ${t.lineName}: ${t.frequency}, ${t.stations.length} stops — ${t.stations.map((s) => `${s.name} [${s.code}/${s.cityId}] ${s.arrival ?? ""}/${s.departure ?? ""}${s.pickup ? "" : " no-on"}${s.dropoff ? "" : " no-off"}`).join(" | ")}`);
}

section("2. Seat classes");
let seatInfo = new Map();
try {
  const body = await fetchRjJson(SEAT_CLASSES_URL);
  save("seat-classes.json", body);
  seatInfo = seatClassMap(body);
  for (const [key, info] of seatInfo) console.log(`  ${key} "${info.title}" — ${JSON.stringify(classifySeatClass({ key, ...info }))} ${info.description ? `(${String(info.description).slice(0, 120)})` : ""}`);
  if (!seatInfo.size) console.log(`  no list read; answer began: ${JSON.stringify(body).slice(0, 600)}`);
} catch (err) {
  console.log(`  ${SEAT_CLASSES_URL}: ${err.message}${err.body ? ` — ${String(err.body).slice(0, 300)}` : ""}`);
}

section(`3. Fares on ${travelDate}`);
for (const [key, t] of Object.entries(trains)) {
  const ep = pricingEnds(t);
  if (!ep) {
    console.log(`${t.lineName}: no booking id at an end`);
    continue;
  }
  const url = buildSearchUrl({ fromId: ep.fromId, toId: ep.toId, date: travelDate });
  console.log(`\n${t.lineName}: ${url}`);
  try {
    const body = await fetchRjJson(url);
    save(`search-${key}.json`, body);
    for (const r of body?.routes ?? []) {
      console.log(`  route ${r.id}: ${r.departureTime} → ${r.arrivalTime}, transfers ${r.transfersCount}, ${JSON.stringify(r.vehicleTypes)}, priceFrom ${r.priceFrom}, bookable ${r.bookable}`);
    }
    if (!Array.isArray(body?.routes)) console.log(`  keys: ${Object.keys(body ?? {}).join(", ")}; began: ${JSON.stringify(body).slice(0, 600)}`);
    const found = findTrainRoute(body, { date: travelDate, departure: ep.departure });
    console.log(`  matched: ${found.route ? found.route.id : "none"}${found.ambiguous ? " (ambiguous)" : ""}`);
    if (!found.route) continue;
    const durl = buildRouteUrl({ routeId: found.route.id, fromId: ep.fromId, toId: ep.toId });
    console.log(`  ${durl}`);
    const detail = await fetchRjJson(durl);
    save(`route-${key}.json`, detail);
    console.log(`  connection keys: ${Object.keys(detail ?? {}).join(", ")}`);
    for (const pc of detail?.priceClasses ?? []) console.log(`  priceClass ${JSON.stringify(pc).slice(0, 400)}`);
    const read = berthClasses(detail, seatInfo);
    console.log(`  read: ${JSON.stringify(read)}`);
  } catch (err) {
    console.log(`  ${err.message}${err.body ? ` — ${String(err.body).replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
  }
}
console.log(`\nraw answers in ${path.relative(root, outDir)}/`);
