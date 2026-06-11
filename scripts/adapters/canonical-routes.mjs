// scripts/adapters/canonical-routes.mjs
// "Curated" source: compiles admin-approved route files
// (data/canonical/routes/*.json, written by route.add proposal approvals)
// into the standard per-source trains map. From here on, curated routes flow
// through exactly the same pipeline as scraped operators — synthetic viewMap
// rows, station injection, detail-panel timetable, review gate.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { renderCalendar } from "../../src/pages/api/lib/calendar.mjs";

const ROUTES_DIR = ["data", "canonical", "routes"];

export function buildCuratedTrains(rootDir) {
  const dir = path.join(rootDir, ...ROUTES_DIR);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return {}; // no curated routes yet
  }

  const trains = {};
  for (const file of files) {
    let route;
    try {
      route = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      console.warn(`[curated] skipping unreadable ${file}: ${err.message}`);
      continue;
    }
    if (route?.status !== "active") continue;
    if (!Array.isArray(route.directions)) continue;

    // The synthetic viewMap key is derived from the first direction's train
    // name; it must equal the file's routeKey or the review gate (seen.json,
    // approved under routeKey) would never match the rendered route.
    const first = route.directions[0];
    const expectedKey = `curated_${(first?.trainName ?? "").replace(/\s+/g, "_")}`;
    if (route.routeKey !== expectedKey) {
      console.warn(
        `[curated] ${file}: routeKey "${route.routeKey}" != derived "${expectedKey}" — skipping`,
      );
      continue;
    }

    for (const dir2 of route.directions) {
      const stations = (dir2.stations ?? [])
        .filter((s) => s?.name && Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .map((s) => ({
          name: s.name,
          location: { latitude: s.lat, longitude: s.lon },
          arrival: s.arrival ?? null,
          departure: s.departure ?? null,
          pickup: true,
          dropoff: true,
        }));
      if (stations.length < 2) continue;

      const positions = stations.map((s) => [s.location.latitude, s.location.longitude]);
      trains[dir2.trainName] = {
        lineName: dir2.trainName,
        operator: route.operatorName || route.agencyId,
        agency_id: route.agencyId,
        frequency: renderCalendar(dir2.calendar),
        polyline: dir2.polyline || polyline.encode(positions),
        stations,
      };
    }
  }
  return trains;
}

export async function run(entry, ctx) {
  const trains = buildCuratedTrains(ctx.rootDir);
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  console.log(`[scrape] compiled ${Object.keys(trains).length} curated train(s)`);
}
