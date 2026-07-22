/**
 * Pure-logic checks for src/lib/geo.js (haversine + nearestStops).
 * Run: node tests/verify-geo.mjs
 */
import assert from "node:assert/strict";
import {
  haversineKm,
  nearestStops,
  formatDistanceKm,
} from "../src/lib/geo.js";

// Berlin → Prague is roughly 280–300 km as the crow flies.
const berlinPrague = haversineKm(52.52, 13.405, 50.0755, 14.4378);
assert.ok(
  berlinPrague > 270 && berlinPrague < 320,
  `Berlin–Prague distance unexpected: ${berlinPrague}`,
);

assert.equal(haversineKm(0, 0, 0, 0), 0);

const stops = [
  { stop_id: "Far", stop_lat: 60, stop_lon: 20 },
  { stop_id: "Near", stop_lat: 52.53, stop_lon: 13.4 },
  { stop_id: "Mid", stop_lat: 51, stop_lon: 13 },
  { stop_id: "NoCoords" },
];

const ranked = nearestStops(stops, 52.52, 13.405, 3);
assert.equal(ranked.length, 3);
assert.equal(ranked[0].stop.stop_id, "Near");
assert.ok(ranked[0].distanceKm < ranked[1].distanceKm);

assert.equal(formatDistanceKm(0.4), "400 m");
assert.match(formatDistanceKm(3.2), /^3\.2 km$/);
assert.match(formatDistanceKm(42), /^42 km$/);

console.log("verify-geo: ok");
