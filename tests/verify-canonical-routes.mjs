// tests/verify-canonical-routes.mjs
// Tests the curated-routes adapter: canonical route files → standard trains
// map, including routeKey consistency with the synthetic viewMap key.
// Run: npm run verify-canonical-routes
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { buildCuratedTrains } from "../scripts/adapters/canonical-routes.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function withRouteFiles(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curated-test-"));
  const dir = path.join(root, "data", "canonical", "routes");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sampleRoute = {
  v: 1,
  routeKey: "curated_TLJ_1920",
  status: "active",
  agencyId: "TCDD",
  operatorName: "TCDD",
  name: "Ankara - Kars (Dogu Ekspresi)",
  directions: [
    {
      trainName: "TLJ 1920",
      calendar: {
        validFrom: null,
        validUntil: null,
        daysOfWeek: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        exceptions: [],
        note: null,
      },
      stations: [
        { name: "Ankara Gar", lat: 39.9359, lon: 32.8474, arrival: null, departure: "18:00" },
        { name: "Kayseri", lat: 38.7349, lon: 35.4843, arrival: "22:58", departure: "23:08" },
        { name: "Kars", lat: 40.6135, lon: 43.0824, arrival: "18:21", departure: null },
      ],
      polyline: null,
    },
    {
      trainName: "TLJ 1921",
      calendar: { validFrom: null, validUntil: null, daysOfWeek: ["mon", "wed"], exceptions: [], note: null },
      stations: [
        { name: "Kars", lat: 40.6135, lon: 43.0824, arrival: null, departure: "08:00" },
        { name: "Kayseri", lat: 38.7349, lon: 35.4843, arrival: "02:58", departure: "03:08" },
        { name: "Ankara Gar", lat: 39.9359, lon: 32.8474, arrival: "08:21", departure: null },
      ],
      polyline: null,
    },
  ],
  pricing: null,
  bookingUrl: null,
  sources: [{ url: "https://www.tcddtasimacilik.gov.tr/", note: "official timetable" }],
};

check("compiles directions into standard trains map", () => {
  withRouteFiles({ "curated_TLJ_1920.json": sampleRoute }, (root) => {
    const trains = buildCuratedTrains(root);
    assert.deepStrictEqual(Object.keys(trains).sort(), ["TLJ 1920", "TLJ 1921"]);
    const fwd = trains["TLJ 1920"];
    assert.strictEqual(fwd.operator, "TCDD");
    assert.strictEqual(fwd.agency_id, "TCDD");
    assert.strictEqual(fwd.frequency, "Daily");
    assert.strictEqual(trains["TLJ 1921"].frequency, "Mon, Wed");
    assert.strictEqual(fwd.stations.length, 3);
    assert.strictEqual(fwd.stations[0].departure, "18:00");
    // polyline encoded from the station chain when not provided
    const decoded = polyline.decode(fwd.polyline);
    assert.strictEqual(decoded.length, 3);
  });
});

check("non-active routes are skipped", () => {
  withRouteFiles(
    { "curated_TLJ_1920.json": { ...sampleRoute, status: "removed" } },
    (root) => {
      assert.deepStrictEqual(buildCuratedTrains(root), {});
    },
  );
});

check("routeKey/trainName mismatch is rejected (gate-key consistency)", () => {
  withRouteFiles(
    { "x.json": { ...sampleRoute, routeKey: "curated_WRONG" } },
    (root) => {
      assert.deepStrictEqual(buildCuratedTrains(root), {});
    },
  );
});

check("stations without coordinates are dropped; short routes skipped", () => {
  const broken = {
    ...sampleRoute,
    directions: [
      {
        ...sampleRoute.directions[0],
        stations: [
          { name: "Ankara Gar", lat: 39.9359, lon: 32.8474 },
          { name: "Nowhere" }, // no coords
        ],
      },
    ],
  };
  withRouteFiles({ "curated_TLJ_1920.json": broken }, (root) => {
    assert.deepStrictEqual(buildCuratedTrains(root), {});
  });
});

check("missing routes directory yields empty map", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curated-empty-"));
  try {
    assert.deepStrictEqual(buildCuratedTrains(root), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n[verify-canonical-routes] ${passed} checks passed`);
