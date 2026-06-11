// scripts/adapters/static-config.mjs
// Builds trains from a curated JSON config (no network): an array of routes
// with station lists; polylines are encoded from the station chain. Routes
// carrying agency_id (e.g. Caucasus) also pass through agency_id + frequency.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";

export function buildTrainsFromConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const trains = {};

  for (const route of config) {
    const stations = route.stations.map((s) => ({
      name: s.name,
      location: { latitude: s.lat, longitude: s.lon },
      arrival: null,
      departure: null,
      pickup: true,
      dropoff: true,
    }));
    const positions = stations.map((s) => [s.location.latitude, s.location.longitude]);
    if (positions.length < 2) continue;

    const extras = route.agency_id
      ? { agency_id: route.agency_id, frequency: route.frequency || null }
      : {};

    trains[route.lineName] = {
      lineName: route.lineName,
      operator: route.operator,
      ...extras,
      polyline: polyline.encode(positions),
      stations,
    };

    if (route.returnLineName) {
      const reversed = [...stations].reverse();
      const revPositions = reversed.map((s) => [s.location.latitude, s.location.longitude]);
      trains[route.returnLineName] = {
        lineName: route.returnLineName,
        operator: route.operator,
        ...extras,
        polyline: polyline.encode(revPositions),
        stations: reversed,
      };
    }
  }

  return trains;
}

export function resolveConfigPath(entry, ctx) {
  return path.join(ctx.rootDir, entry.params.configPath);
}

export async function run(entry, ctx) {
  const trains = buildTrainsFromConfig(resolveConfigPath(entry, ctx));
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  console.log(`[scrape] stored ${Object.keys(trains).length} ${entry.id} trains`);
}
