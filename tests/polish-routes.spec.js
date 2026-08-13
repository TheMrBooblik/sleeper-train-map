import { test, expect } from "@playwright/test";
import { attachPkpGtfsPolylinesToViewMap } from "../src/lib/pkpGtfsMerge.js";

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function maxGapKm(positions) {
  let max = 0;
  for (let i = 1; i < positions.length; i++) {
    max = Math.max(max, haversineKm(positions[i - 1], positions[i]));
  }
  return max;
}

// Inline key-extraction logic (mirrors src/lib/pkpTrainKeyExtract.js without ESM)
function extractKeysFromTripLabel(label) {
  const s = String(label || "");
  const keys = [];
  const push = (k) => {
    if (k && !keys.includes(k)) keys.push(k);
  };
  const ic = s.match(/\bIC\s+(\d{3,6})\b/i);
  if (ic) push(ic[1]);
  const tlk = s.match(/\bTLK\s+(\d{3,6})\b/i);
  if (tlk) push(tlk[1]);
  const slash = s.match(/\/(\d{3,6})(?:\D|$)/);
  if (slash) push(slash[1]);
  const en = s.match(/\bEN\s+(\d{3,6})\b/i);
  if (en) push(en[1]);
  const ec = s.match(/\bEC\s+(\d{3,6})\b/i);
  if (ec) push(ec[1]);
  const le = s.match(/\bLE\s+(\d{3,6})\b/i);
  if (le) push(le[1]);
  (s.match(/\d{4,6}/g) || []).forEach((n) => push(n));
  return keys;
}

function positionsForLabel(label, byTrainKey) {
  for (const k of extractKeysFromTripLabel(label)) {
    const entry = byTrainKey[k];
    if (entry?.positions?.length >= 2) return entry.positions;
  }
  return null;
}

function isPrzemyslSwinoujscieRoute(r) {
  const fields = [
    r.origin_trip_0,
    r.destination_trip_0,
    r.origin_trip_1,
    r.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());
  return (
    fields.some((f) => f.includes("przemyśl") || f.includes("przemysl")) &&
    fields.some((f) => f.includes("winouj"))
  );
}

function isPrahaWarszawaRoute(r) {
  const fields = [
    r.origin_trip_0,
    r.destination_trip_0,
    r.origin_trip_1,
    r.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());
  return (
    fields.some((f) => f.includes("praha")) &&
    fields.some((f) => f.includes("warszawa"))
  );
}

const EXPECTED_GTFS_KEYS = [
  "406",
  "407",
  "430",
  "431",
  "460",
  "461",
  "16170",
  "28170",
  "35170",
  "38170",
  "38172",
  "53170",
  "61170",
  "82170",
  "83170",
  "83172",
  // Kraków/Bohumín ↔ Łeba (Korsarz/Wydmy): rail to Lębork, bus on to Łeba.
  "35190",
  "53190",
  "403",
  "402",
  // Leo Express Frankfurt ↔ Przemyśl sleeper (mkuran LEO agency).
  "1248",
  "1249",
];

const GAP_THRESHOLD_KM = 30;

test.describe("Polish train routes", () => {
  test("GTFS bundle has all expected keys and gapless polylines", async ({
    request,
  }) => {
    const res = await request.get("/data/gtfs/pkpTrainShapes.json");
    expect(res.ok()).toBeTruthy();
    const bundle = await res.json();
    expect(bundle.byTrainKey).toBeDefined();

    for (const key of EXPECTED_GTFS_KEYS) {
      const shape = bundle.byTrainKey[key];
      expect(shape, `Missing GTFS key ${key}`).toBeDefined();

      const pts = shape.positions;
      expect(
        pts.length,
        `Key ${key}: too few points (${pts.length})`,
      ).toBeGreaterThanOrEqual(500);

      const gap = maxGapKm(pts);
      expect(
        gap,
        `Key ${key}: gap of ${gap.toFixed(1)} km exceeds ${GAP_THRESHOLD_KM} km`,
      ).toBeLessThan(GAP_THRESHOLD_KM);
    }

    // Korsarz/Wydmy run by bus on the closed Lębork–Łeba section, so the rail
    // shape ends at Lębork but the journey must reach Łeba via a bus segment.
    for (const key of ["35190", "403"]) {
      const shape = bundle.byTrainKey[key];
      const lastStop = shape.stops[shape.stops.length - 1].name;
      expect(lastStop, `Key ${key} should end at Łeba`).toBe("Łeba");
      const reachesLeba = shape.bus_segments?.some((s) => s.to === "Łeba");
      expect(reachesLeba, `Key ${key} missing bus segment to Łeba`).toBeTruthy();
    }
  });

  test("static Polish polylines are gapless", async ({ request }) => {
    const staticFiles = [
      "/data/przemyslSwinoujsciePolyline.json",
      "/data/enHumennePolyline.json",
      "/data/rj1038Polyline.json",
      "/data/rjChopPolyline.json",
      "/data/zemplinPolyline.json",
    ];

    for (const file of staticFiles) {
      const res = await request.get(file);
      expect(res.ok(), `${file} not found`).toBeTruthy();
      const raw = await res.json();
      const positions = Array.isArray(raw) ? raw : raw.positions;
      expect(
        positions.length,
        `${file}: too few points (${positions.length})`,
      ).toBeGreaterThan(100);

      const gap = maxGapKm(positions);
      expect(
        gap,
        `${file}: gap of ${gap.toFixed(1)} km exceeds ${GAP_THRESHOLD_KM} km`,
      ).toBeLessThan(GAP_THRESHOLD_KM);
    }
  });

  test("API returns PKP routes with expected endpoint stations", async ({
    request,
  }) => {
    const res = await request.get("/api/initial-data");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const viewMap = data.viewMap || {};

    const pkpRoutes = Object.values(viewMap).filter(
      (r) => r?.agency_id === "PKP" || r?.agency_id === "PKP/ČD",
    );
    expect(
      pkpRoutes.length,
      `Expected >= 10 PKP routes, got ${pkpRoutes.length}`,
    ).toBeGreaterThanOrEqual(10);

    const allEndpoints = pkpRoutes.flatMap((r) =>
      [
        r.origin_trip_0,
        r.destination_trip_0,
        r.origin_trip_1,
        r.destination_trip_1,
      ]
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
    );

    const mustContain = [
      "warszawa",
      "przemyśl",
      "kraków",
      "gdynia",
      "winouj",
      "praha",
    ];
    for (const needle of mustContain) {
      expect(
        allEndpoints.some((s) => s.includes(needle)),
        `No PKP route endpoint containing "${needle}"`,
      ).toBeTruthy();
    }

    // EN 40406/40407 (München↔Warszawa) replaces BoT route 116 with an NJ standalone entry.
    // Iteration order determines which direction becomes route_id, so check both names.
    const enRoute = Object.values(viewMap).find(
      (r) =>
        r?.trip_short_name_0 === "EN 40406" ||
        r?.trip_short_name_1 === "EN 40406" ||
        r?.trip_short_name_0 === "EN 40407" ||
        r?.trip_short_name_1 === "EN 40407",
    );
    expect(enRoute, "EN 40406/40407 München↔Warszawa route not found").toBeDefined();
    expect(
      enRoute.nj_polyline,
      "EN 40406/40407 route missing nj_polyline",
    ).toBeTruthy();
  });

  test("GTFS merge attaches positions to PKP routes", async ({ request }) => {
    const [dataRes, bundleRes] = await Promise.all([
      request.get("/api/initial-data"),
      request.get("/data/gtfs/pkpTrainShapes.json"),
    ]);
    expect(dataRes.ok()).toBeTruthy();
    expect(bundleRes.ok()).toBeTruthy();

    const data = await dataRes.json();
    const bundle = await bundleRes.json();
    const viewMap = data.viewMap || {};
    const byTrainKey = bundle.byTrainKey;

    const pkpRoutes = Object.values(viewMap).filter(
      (r) => r?.agency_id === "PKP" || r?.agency_id === "PKP/ČD",
    );

    for (const route of pkpRoutes) {
      if (route.nj_polyline) continue;
      if (isPrzemyslSwinoujscieRoute(route)) continue;
      if (isPrahaWarszawaRoute(route)) continue;

      const p0 = positionsForLabel(route.trip_short_name_0, byTrainKey);
      // Any route whose key resolves to a shape should have >= 200 points.
      if (p0 !== null) {
        expect(
          p0.length,
          `Route ${route.route_id} (${route.trip_short_name_0}) trip0: only ${p0.length} pts`,
        ).toBeGreaterThanOrEqual(200);
      }

      if (route.trip_short_name_1) {
        const p1 = positionsForLabel(route.trip_short_name_1, byTrainKey);
        // p1 may fall back to reversed p0 after the pkpGtfsMerge fix
        if (p1 !== null) {
          expect(
            p1.length,
            `Route ${route.route_id} (${route.trip_short_name_1}) trip1: only ${p1.length} pts`,
          ).toBeGreaterThanOrEqual(200);
        }
      }
    }
  });

  test("compound Hel routes stitch to peninsula geometry", async ({
    request,
  }) => {
    // Routes whose trip labels carry two train numbers (a main corridor leg +
    // the Gdynia→Hel spur, e.g. "TLK 35190/50191"). The client merge stitches
    // them at Gdynia so the line follows the coastal railway to Hel instead of
    // a straight chord across the bay.
    const [dataRes, bundleRes] = await Promise.all([
      request.get("/api/initial-data"),
      request.get("/data/gtfs/pkpTrainShapes.json"),
    ]);
    expect(dataRes.ok()).toBeTruthy();
    expect(bundleRes.ok()).toBeTruthy();

    const data = await dataRes.json();
    const bundle = await bundleRes.json();
    const merged = attachPkpGtfsPolylinesToViewMap(data.viewMap || {}, bundle);

    const helRoutes = Object.values(merged).filter((r) =>
      [r?.origin_trip_0, r?.destination_trip_0].includes("Hel"),
    );
    expect(
      helRoutes.length,
      "expected at least 2 Hel routes (Kraków↔Hel, Bohumín↔Hel)",
    ).toBeGreaterThanOrEqual(2);

    for (const route of helRoutes) {
      for (const dir of ["0", "1"]) {
        if (!route[`origin_trip_${dir}`]) continue;
        const positions = route[`pkp_gtfs_positions_${dir}`];
        expect(
          positions?.length,
          `Route ${route.route_id} trip${dir} (${route[`trip_short_name_${dir}`]}) lacks stitched geometry`,
        ).toBeGreaterThanOrEqual(200);

        // Stitched legs render as separate rail segments (main corridor + spur).
        expect(
          route[`pkp_rail_segments_${dir}`]?.length,
          `Route ${route.route_id} trip${dir} should have >= 2 rail segments`,
        ).toBeGreaterThanOrEqual(2);

        // The line must actually reach the Hel peninsula, not stop at Gdynia.
        const gap = maxGapKm(positions);
        expect(
          gap,
          `Route ${route.route_id} trip${dir}: ${gap.toFixed(1)} km gap (chord fallback?)`,
        ).toBeLessThan(GAP_THRESHOLD_KM);
      }
    }
  });

  test("Polish routes render on map (screenshot)", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 15000 });
    // Wait for station markers to appear (data loaded)
    await page.waitForSelector(".leaflet-marker-icon", { timeout: 20000 });
    // Open the settings popover, then enable "Show all routes" to render route polylines
    await page.getByRole("button", { name: /map settings/i }).click();
    await page.getByRole("switch", { name: /show all routes/i }).click();
    // Give React time to render polylines (startTransition defers the update)
    await page.waitForTimeout(4000);
    await page.screenshot({
      path: "tests/screenshots/polish-routes-map.png",
      fullPage: false,
    });
  });
});
