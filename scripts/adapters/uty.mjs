// scripts/adapters/uty.mjs
// Uzbekistan Railways (O'zbekiston temir yo'llari) night trains — the nightly refresh.
//
//   1. UTY's ticket shop, eticket.uzrailpass.uz, searched the way its own page
//      searches before login (scripts/lib/uty.mjs): from Toshkent Janubiy to
//      every station in data/sources/uty-sleepers.json and back, on the sweep
//      date(s) — each night train's stop list and the official time at each
//      stop — then between each train's own two ends over seven dates: the
//      nights it runs and the fare of every berth for the whole journey.
//      About 190 requests a night, 1.5 s apart.
//   2. OpenStreetMap's railway network, from the weekly tiled Overpass cache
//      (scripts/lib/osm-track.mjs), so the line follows the track.
//
// Never fatal for the map: when the shop cannot be read the trains are
// rebuilt from last night's file (for up to 30 days) and the run returns a
// warning for source-health.json. A block ends the night's searches.
// The "Probe UTY source" workflow (label a PR `run-probes`) prints what the
// shop answers.

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "../lib/http-block.mjs";
import { loadOsmTrack } from "../lib/osm-track.mjs";
import { buildUtyTrains, makeUtyClient, readNight } from "../lib/uty.mjs";

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = JSON.parse(fs.readFileSync(path.join(ctx.rootDir, params.configPath), "utf8"));
  const previousFile = readJsonSafe(path.join(ctx.rootDir, "public/data/scraped", entry.output));
  const previous = previousFile?.data?.trains ?? previousFile?.trains ?? {};
  const offsetDays = params.dateOffsetDays ?? 7;
  const travelDate = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const fetchImpl = ctx.fetch ?? fetch;
  const warnings = [];

  // 1. The shop.
  let found = null;
  const carriedPrevious = { ...previous };
  const client = makeUtyClient({
    base: params.baseUrl,
    fetchImpl,
    detectBlock,
    userAgent: HONEST_USER_AGENT,
    log,
    ...(params.spacingMs != null ? { spacingMs: params.spacingMs } : {}),
    ...(params.maxRequests != null ? { maxRequests: params.maxRequests } : {}),
  });
  try {
    const night = await readNight({ client, config, today: ctx.today, offsetDays, previous, log });
    log(`sweep date(s) ${night.dates.join(", ")}: ${night.found.size} night train(s) ${[...night.found.keys()].join(", ") || "—"}; left out ${night.skipped.join("; ") || "nothing"}`);
    if (night.failures) warnings.push(`${night.failures} search(es) failed`);
    for (const [number, r] of night.refreshed) {
      const name = Object.keys(carriedPrevious).find((k) => carriedPrevious[k].trainNo === number);
      if (name) carriedPrevious[name] = { ...carriedPrevious[name], frequency: r.frequency, ...(r.fare ? { fare: r.fare } : {}) };
    }
    if (!night.found.size && !Object.keys(previous).length) throw new Error("no night train found and no previous file");
    found = night.found;
  } catch (err) {
    warnings.push(`eticket: ${err.message} — trains rebuilt from last night's file`);
    log(warnings.at(-1));
  }
  log(`eticket: ${client.requests} request(s)`);

  // 2. Track.
  const osmTrack = params.osmTrack ? await loadOsmTrack({ rootDir: ctx.rootDir, today: ctx.today, params: params.osmTrack, fetchImpl, log }) : null;

  const trains = buildUtyTrains({ config, found, previous: carriedPrevious, today: ctx.today, travelDate, osmTrack, log });
  if (!Object.keys(trains).length) throw new Error(`no trains built (${warnings.join("; ") || "nothing kept"})`);
  for (const t of Object.values(trains)) {
    const a = t.stations[0];
    const b = t.stations.at(-1);
    const fare = t.fare ? `from ${t.fare.fromPrice} so'm (${Object.entries(t.fare.classes).map(([k, v]) => `${k} ${v}`).join(", ")})` : "no fare";
    log(`${t.lineName}: ${a.name} ${a.departure} → ${b.name} ${b.arrival} (+${b.arrivalDay}), ${t.stations.length} stops, ${t.frequency ?? "days unknown"}, ${fare}, line ${JSON.stringify(t.geometry)}${t.timetable?.source === "previous" ? " [carried]" : ""}`);
  }
  ctx.write(entry.output, { uploadedAt: ctx.today, travelDate, trains });
  log(`stored ${Object.keys(trains).length} train(s)`);
  return warnings.length ? { warning: warnings.join("; ") } : undefined;
}
