// scripts/gen-route-polyline.mjs
// One-off, reproducible generator for the manual route-geometry override
// (data/overrides/route-polylines.json). NOT registry-wired — run by hand when
// you need to attach a real track polyline to a Back-on-Track row that ships
// without one.
//
// Current target: European Sleeper ES475 (BoT route_id 238, direction 1 =
// Paris Gare du Nord → Berlin Hbf). Strategy:
//
//   * Brussels → Berlin comes straight from OSM: the already-cached relation
//     18616102 ("European Sleeper 453: Bruxelles Midi → Praha hl.n", an ordered
//     GPX track) runs Brussels → Liège → … → Berlin → … → Praha. We slice it
//     from the point nearest Bruxelles Midi to the point nearest Berlin Hbf.
//   * Paris → Brussels (Paris Gare du Nord → Aulnoye-Aymeries → Bruxelles Midi)
//     is NOT in that relation, so it's added as a straight lead-in. (Overpass
//     discovery of that leg is unavailable from the sandbox — 403 — so this is
//     the offline path; re-run with network to upgrade the lead-in if desired.)
//
// The whole thing is oriented Paris → Berlin, @mapbox/polyline-encoded, and
// written to data/overrides/route-polylines.json under route_id "238" →
// nj_polyline_1. Prints method / point count / length / bbox for human review.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import REL_18616102 from "../public/data/scraped/osm-18616102.json" with { type: "json" };
import {
  relationCoordsFromOverpass,
  deduplicateConsecutive,
} from "../src/pages/api/lib/osm-geo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "overrides",
  "route-polylines.json",
);

// ES475 ordered stops (Paris → Berlin), coords from backontrack-stops.json.
const PARIS_NORD = [48.8808487, 2.3555021];
const AULNOYE = [50.197441, 3.8434166];
const BRUXELLES_MIDI = [50.8368108, 4.33740096];
const BERLIN_HBF = [52.5250839, 13.369402];

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function nearestIndex(coords, target) {
  let best = -1;
  let bestKm = Infinity;
  coords.forEach((c, i) => {
    const km = haversineKm(c, target);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  });
  return { index: best, km: bestKm };
}

function pathLengthKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineKm(coords[i - 1], coords[i]);
  return total;
}

function bbox(coords) {
  const lats = coords.map((c) => c[0]);
  const lons = coords.map((c) => c[1]);
  return {
    latMin: Math.min(...lats),
    latMax: Math.max(...lats),
    lonMin: Math.min(...lons),
    lonMax: Math.max(...lons),
  };
}

function buildEs475() {
  // Ordered GPX track Brussels → … → Berlin → … → Praha.
  const track = relationCoordsFromOverpass(REL_18616102.data, "18616102");
  if (track.length < 2) throw new Error("relation 18616102 has no usable geometry");

  const brussels = nearestIndex(track, BRUXELLES_MIDI);
  const berlin = nearestIndex(track, BERLIN_HBF);
  if (brussels.index < 0 || berlin.index < 0) {
    throw new Error("could not locate Brussels/Berlin on the track");
  }
  if (brussels.km > 30 || berlin.km > 30) {
    throw new Error(
      `track does not pass near both endpoints (Brussels ${brussels.km.toFixed(1)} km, Berlin ${berlin.km.toFixed(1)} km)`,
    );
  }

  // Slice the Brussels → Berlin portion (track runs Brussels-first).
  const [lo, hi] = [brussels.index, berlin.index].sort((a, b) => a - b);
  let brusselsToBerlin = track.slice(lo, hi + 1);
  // Orient Brussels → Berlin regardless of which end we sliced from.
  if (haversineKm(brusselsToBerlin[0], BRUXELLES_MIDI) >
      haversineKm(brusselsToBerlin[brusselsToBerlin.length - 1], BRUXELLES_MIDI)) {
    brusselsToBerlin = [...brusselsToBerlin].reverse();
  }

  // Straight Paris → Aulnoye lead-in; the track already starts at Brussels.
  const coords = deduplicateConsecutive([
    PARIS_NORD,
    AULNOYE,
    ...brusselsToBerlin,
  ]);
  return { coords, brussels, berlin, trackLen: track.length };
}

function main() {
  const { coords, brussels, berlin, trackLen } = buildEs475();
  const startKm = haversineKm(coords[0], PARIS_NORD);
  const endKm = haversineKm(coords[coords.length - 1], BERLIN_HBF);
  const encoded = polyline.encode(coords);

  const current = fs.existsSync(OVERRIDE_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8"))
    : {};
  current["238"] = { ...(current["238"] || {}), nj_polyline_1: encoded };
  fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(current, null, 2) + "\n");

  console.log("ES475 (route_id 238) direction 1 — Paris → Berlin");
  console.log(`  method:        OSM relation 18616102 (Brussels→Berlin) + straight Paris→Brussels lead-in`);
  console.log(`  source track:  ${trackLen} pts; Brussels @idx ${brussels.index} (${brussels.km.toFixed(1)} km), Berlin @idx ${berlin.index} (${berlin.km.toFixed(1)} km)`);
  console.log(`  output points: ${coords.length}`);
  console.log(`  length:        ${pathLengthKm(coords).toFixed(0)} km`);
  console.log(`  bbox:          ${JSON.stringify(bbox(coords))}`);
  console.log(`  endpoints:     start ${startKm.toFixed(1)} km from Paris Nord, end ${endKm.toFixed(1)} km from Berlin Hbf`);
  console.log(`  wrote:         ${path.relative(path.join(__dirname, ".."), OVERRIDE_PATH)}`);
}

main();
