// tests/verify-mobile-payload.mjs
//
// The mobile payload is the whole contract with the app: it is built once a
// night from the repo's own render modules, and a published app can only draw
// what it finds there. Nothing else checks it — the Playwright suites exercise
// the web renderer, which reads the payload's *inputs*, not the payload.
//
// So this suite guards the three ways it can go wrong silently:
//   1. shape — a route without geometry, a group pointing at a station index
//      that does not exist, a station with no coordinates: all render as a
//      quietly missing line or dot, never as an error;
//   2. date-independence — the payload must carry seasonRanges/futureStarts
//      rather than the verdicts `isRouteOutsideServiceIdSeason` and
//      `getFutureRouteStartDate` derive from them, or a seed copy shipped in
//      the APK tells a phone in November what was true in August;
//   3. size — the app has a 30 MB store budget and this file is bundled.
//
// Raw node, no network, no browser. Run: npm run verify-mobile-payload
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";

import { build } from "../scripts/build-mobile-payload.mjs";
import {
  simplifyPath,
  dedupeConsecutive,
  encodeStroke,
  parseDashArray,
  DEFAULT_TOLERANCE_DEG,
} from "../scripts/lib/mobile-geometry.mjs";
import {
  toWallClock,
  matchesEndpoint,
} from "../scripts/lib/mobile-schedules.mjs";
import { distanceKm } from "../src/components/Map/utils/returnGeometryBranches.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RAW_BYTES = 3 * 1024 * 1024;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

check("simplifyPath keeps both endpoints", () => {
  const pts = [
    [50, 14],
    [50.5, 14.2],
    [51, 14.4],
    [52, 15],
  ];
  const out = simplifyPath(pts, 1e-3);
  assert.deepStrictEqual(out[0], pts[0]);
  assert.deepStrictEqual(out[out.length - 1], pts[pts.length - 1]);
});

check("simplifyPath drops points on a straight line", () => {
  const straight = Array.from({ length: 50 }, (_, i) => [50 + i * 0.01, 14]);
  const out = simplifyPath(straight, DEFAULT_TOLERANCE_DEG);
  assert.strictEqual(out.length, 2, `expected 2 points, got ${out.length}`);
});

check("simplifyPath keeps a corner that exceeds the tolerance", () => {
  // A 0.05° detour is ~5 km — two orders of magnitude past the tolerance.
  const withCorner = [
    [50, 14],
    [50.05, 14.5],
    [50, 15],
  ];
  assert.strictEqual(simplifyPath(withCorner, DEFAULT_TOLERANCE_DEG).length, 3);
});

check("simplifyPath handles degenerate input", () => {
  assert.deepStrictEqual(simplifyPath([], 1e-3), []);
  assert.deepStrictEqual(simplifyPath([[1, 2]], 1e-3), [[1, 2]]);
  assert.deepStrictEqual(simplifyPath(null, 1e-3), []);
});

check("simplifyPath survives a long path without recursing", () => {
  // 40k points: a real OSM relation is ~24k, and a stack-based implementation
  // is the reason this does not throw RangeError.
  const long = Array.from({ length: 40000 }, (_, i) => [
    50 + Math.sin(i / 500) * 0.5,
    14 + i * 1e-4,
  ]);
  const out = simplifyPath(long, DEFAULT_TOLERANCE_DEG);
  assert.ok(out.length > 2 && out.length < long.length);
});

check(
  "dedupeConsecutive collapses repeated coordinates only when adjacent",
  () => {
    const out = dedupeConsecutive([
      [1, 1],
      [1, 1],
      [2, 2],
      [1, 1],
    ]);
    assert.deepStrictEqual(out, [
      [1, 1],
      [2, 2],
      [1, 1],
    ]);
  },
);

check(
  "encodeStroke rejects a stroke with fewer than two distinct points",
  () => {
    assert.strictEqual(encodeStroke([[1, 1]]), null);
    assert.strictEqual(
      encodeStroke([
        [1, 1],
        [1, 1],
      ]),
      null,
    );
    assert.strictEqual(
      encodeStroke([
        [1, 1],
        [NaN, 2],
      ]),
      null,
    );
  },
);

check("encodeStroke round-trips through @mapbox/polyline", () => {
  const pts = [
    [50.0831, 14.4361],
    [50.5, 14.9],
    [51.0, 15.5],
  ];
  const stroke = encodeStroke(pts, DEFAULT_TOLERANCE_DEG);
  const decoded = polyline.decode(stroke.encoded);
  assert.strictEqual(decoded.length, pts.length);
  decoded.forEach(([lat, lng], i) => {
    assert.ok(Math.abs(lat - pts[i][0]) < 1e-4);
    assert.ok(Math.abs(lng - pts[i][1]) < 1e-4);
  });
});

check("parseDashArray accepts both Leaflet spellings and rejects junk", () => {
  assert.deepStrictEqual(parseDashArray("10,5"), [10, 5]);
  assert.deepStrictEqual(parseDashArray("8 6"), [8, 6]);
  assert.strictEqual(parseDashArray(undefined), null);
  assert.strictEqual(parseDashArray("solid"), null);
  assert.strictEqual(
    parseDashArray("5"),
    null,
    "a single segment is not a dash",
  );
});

// ---------------------------------------------------------------------------
// Timetable primitives
// ---------------------------------------------------------------------------

check(
  "toWallClock reads a floating ISO string without touching the clock",
  () => {
    // The build runs in UTC; the browser that renders this may not. A floating ISO
    // string means the same wall time everywhere, so the digits are the answer and
    // constructing a Date would only invite the runner's zone in.
    assert.strictEqual(toWallClock("2026-08-30T15:45:00"), "15:45");
    assert.strictEqual(toWallClock("2026-08-30T05:05:00.000"), "05:05");
  },
);

check("toWallClock normalises plain times and rejects junk", () => {
  assert.strictEqual(toWallClock("9:41"), "09:41", "ČD emits unpadded hours");
  assert.strictEqual(toWallClock("21:03"), "21:03");
  assert.strictEqual(toWallClock(null), null);
  assert.strictEqual(toWallClock(""), null);
  assert.strictEqual(toWallClock("soon"), null);
});

check("matchesEndpoint is the panel's loose containment match", () => {
  assert.ok(matchesEndpoint("Praha hl.n.", "Praha hl.n"));
  assert.ok(matchesEndpoint("Wien Hbf", "Wien"));
  assert.ok(!matchesEndpoint("Wien Hbf", "Praha"));
  assert.ok(!matchesEndpoint("", "Praha"));
});

// ---------------------------------------------------------------------------
// The payload itself
// ---------------------------------------------------------------------------

const { payload, stats } = build();
const json = JSON.stringify(payload);

check("payload declares its schema version and provenance", () => {
  assert.strictEqual(payload.v, 1);
  assert.ok(Date.parse(payload.generatedAt) > 0);
  assert.ok(payload.dataUploadedAt, "dataUploadedAt traces back to the scrape");
});

check("payload fits the size budget", () => {
  assert.ok(
    json.length <= MAX_RAW_BYTES,
    `${(json.length / 1024).toFixed(0)} KB exceeds ${MAX_RAW_BYTES / 1024} KB`,
  );
});

check("every route carries drawable geometry", () => {
  assert.ok(
    payload.routes.length > 100,
    `only ${payload.routes.length} routes`,
  );
  for (const r of payload.routes) {
    assert.ok(r.geom?.length > 0, `route ${r.id} has no geometry`);
    for (const g of r.geom) {
      const pts = polyline.decode(g.p);
      assert.ok(
        pts.length >= 2,
        `route ${r.id} has a stroke with ${pts.length} points`,
      );
      for (const [lat, lng] of pts) {
        assert.ok(
          Number.isFinite(lat) && lat >= -90 && lat <= 90,
          `route ${r.id} latitude ${lat} out of range`,
        );
        assert.ok(
          Number.isFinite(lng) && lng >= -180 && lng <= 180,
          `route ${r.id} longitude ${lng} out of range`,
        );
      }
    }
  }
});

check("every route has at least one direction with endpoints", () => {
  for (const r of payload.routes) {
    assert.ok(r.dirs?.length > 0, `route ${r.id} has no directions`);
    for (const d of r.dirs) {
      assert.ok(
        d.from && d.to,
        `route ${r.id} direction ${d.d} is missing an endpoint`,
      );
      assert.ok(
        Array.isArray(d.via),
        `route ${r.id} direction ${d.d} via is not a list`,
      );
    }
  }
});

check("route styling is renderable without parsing strings", () => {
  for (const r of payload.routes) {
    assert.ok(
      /^#[0-9a-f]{6}$/i.test(r.color || ""),
      `route ${r.id} colour ${r.color}`,
    );
    assert.ok(
      Number.isFinite(r.weight) && r.weight > 0,
      `route ${r.id} weight`,
    );
    if (r.dash !== null) {
      assert.ok(
        Array.isArray(r.dash) &&
          r.dash.length >= 2 &&
          r.dash.every(Number.isFinite),
        `route ${r.id} dash ${JSON.stringify(r.dash)} is not numeric segments`,
      );
    }
  }
});

check("the payload bakes date INPUTS, never date verdicts", () => {
  const forbidden = ["isFuture", "hidden", "futureStartDate", "isSeasonalNow"];
  for (const r of payload.routes) {
    for (const key of forbidden) {
      assert.ok(
        !(key in r),
        `route ${r.id} carries "${key}" — a verdict computed against the build date. ` +
          `The app re-evaluates seasonRanges/futureStarts against its own clock.`,
      );
    }
    assert.ok(Array.isArray(r.seasonRanges), `route ${r.id} seasonRanges`);
    assert.ok(Array.isArray(r.futureStarts), `route ${r.id} futureStarts`);
    assert.strictEqual(
      typeof r.seasonBounded,
      "boolean",
      `route ${r.id} seasonBounded`,
    );
    for (const range of r.seasonRanges) {
      assert.ok(
        range.length === 2 && range.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
        `route ${r.id} season range ${JSON.stringify(range)} is not [ISO, ISO]`,
      );
      assert.ok(
        range[0] <= range[1],
        `route ${r.id} season range ends before it starts`,
      );
    }
    for (const d of r.futureStarts) {
      assert.ok(
        /^\d{4}-\d{2}-\d{2}$/.test(d),
        `route ${r.id} future start ${d}`,
      );
    }
  }
});

check("at least one route exercises the future-start path", () => {
  // Guards the extraction itself: if the regexes stopped matching, every list
  // would be empty and the checks above would pass vacuously.
  const withFuture = payload.routes.filter((r) => r.futureStarts.length > 0);
  assert.ok(
    withFuture.length > 0,
    "no route carries a future start date — has the irregularities format changed?",
  );
});

const allSchedules = payload.routes.flatMap((r) =>
  r.dirs.flatMap((d) =>
    [d.schedule, d.cdSchedule].filter(Boolean).map((s) => ({ r, d, s })),
  ),
);

check("timetables are well formed", () => {
  assert.ok(
    allSchedules.length > 100,
    `only ${allSchedules.length} timetables`,
  );
  for (const { r, d, s } of allSchedules) {
    assert.ok(s.src, `route ${r.id}/${d.train} timetable has no source`);
    assert.ok(
      s.tz === "utc" || s.tz === "wall",
      `route ${r.id}/${d.train} tz is ${JSON.stringify(s.tz)}`,
    );
    assert.ok(
      s.stops?.length >= 2,
      `route ${r.id}/${d.train} timetable has ${s.stops?.length} stops`,
    );
    for (const stop of s.stops) {
      assert.strictEqual(
        stop.length,
        3,
        "a stop is [name, arrival, departure]",
      );
      assert.ok(stop[0], `route ${r.id}/${d.train} has an unnamed stop`);
    }
  }
});

check("a timetable never mixes instants with wall clock times", () => {
  // This is the whole timezone contract: `utc` means the app must localise every
  // value, `wall` means it must localise none. A schedule carrying both would be
  // rendered half right, and the error is ~2 hours — plausible enough to miss.
  const isInstant = (v) => /T/.test(v) && /(Z|[+-]\d{2}:?\d{2})$/.test(v);
  for (const { r, d, s } of allSchedules) {
    const values = s.stops.flatMap(([, a, b]) => [a, b]).filter(Boolean);
    const instants = values.filter(isInstant).length;
    if (s.tz === "utc") {
      assert.strictEqual(
        instants,
        values.length,
        `route ${r.id}/${d.train} is tagged utc but ${values.length - instants} ` +
          `of ${values.length} times are not instants`,
      );
    } else {
      assert.strictEqual(
        instants,
        0,
        `route ${r.id}/${d.train} is tagged wall but carries ${instants} instants — ` +
          `the app would print them in the wrong zone`,
      );
      for (const v of values) {
        assert.ok(
          /^\d{2}:\d{2}$/.test(v),
          `route ${r.id}/${d.train} wall time ${JSON.stringify(v)} is not HH:MM`,
        );
      }
    }
  }
});

check("the feeds that publish instants are still tagged utc", () => {
  // nightjet and italian are the only two feeds whose times carry a Z. If a
  // scrape change ever made them floating, tagging would silently follow and
  // every one of those timetables would shift by the viewer's offset.
  const bySource = new Map();
  for (const { s } of allSchedules) {
    if (!bySource.has(s.src)) bySource.set(s.src, new Set());
    bySource.get(s.src).add(s.tz);
  }
  for (const src of ["nightjet", "it"]) {
    assert.deepStrictEqual(
      [...(bySource.get(src) || [])],
      ["utc"],
      `${src} timetables must be tagged utc, got ${JSON.stringify([...(bySource.get(src) || [])])}`,
    );
  }
  for (const [src, tzs] of bySource) {
    if (src === "nightjet" || src === "it") continue;
    assert.deepStrictEqual(
      [...tzs],
      ["wall"],
      `${src} timetables should be wall clock, got ${JSON.stringify([...tzs])}`,
    );
  }
});

check("the European Sleeper feed only reaches European Sleeper trains", () => {
  // The feed is keyed by BARE train number and Back-on-Track carries a CFM/CFR
  // 401 and an SJN 475 next to ES 401/475. Without the agency guard those two
  // render European Sleeper's stops.
  for (const { r, d, s } of allSchedules) {
    if (s.src !== "europeansleeper") continue;
    const isEs =
      String(r.id).startsWith("es_") ||
      String(r.agency).toUpperCase() === "ES" ||
      String(r.feedAgency || "").toUpperCase() === "ES";
    assert.ok(
      isEs,
      `route ${r.id} (agency ${r.agency}) train ${d.train} got European Sleeper's ` +
        `timetable — the bare-number guard is not holding`,
    );
  }
});

check("timetable coverage has not collapsed", () => {
  // A feed that returned 20 timetables yesterday and 0 today is a broken scrape,
  // and the payload would ship the gap silently. Assert per-source floors well
  // under today's numbers so ordinary drift does not trip it.
  const counts = stats.scheduleSources;
  const floors = { nightjet: 30, cr: 50, pkp: 20, it: 15, na: 8, cd: 15 };
  for (const [src, floor] of Object.entries(floors)) {
    assert.ok(
      (counts[src] || 0) >= floor,
      `only ${counts[src] || 0} ${src} timetables resolved (floor ${floor}) — ` +
        `check public/data/scraped/${src}-trains.json`,
    );
  }
  assert.ok(
    stats.withSchedule >= 200,
    `only ${stats.withSchedule} of ${stats.dirs} directions carry a timetable`,
  );
});

check("the ČD accordion stays separate from the main timetable", () => {
  // cdSchedule is rendered as its own second accordion, never as a replacement,
  // so it must not overwrite the winner of the precedence chain.
  const withBoth = payload.routes.flatMap((r) =>
    r.dirs.filter((d) => d.schedule && d.cdSchedule),
  );
  for (const d of withBoth) {
    assert.strictEqual(
      d.cdSchedule.src,
      "cd",
      "the second accordion must always be the ČD one",
    );
  }
});

check("stations are drawable and route-linked", () => {
  assert.ok(
    payload.stations.length > 1000,
    `only ${payload.stations.length} stations`,
  );
  for (const s of payload.stations) {
    assert.ok(s.n, "station without a name");
    assert.ok(
      Number.isFinite(s.y) && s.y >= -90 && s.y <= 90,
      `station ${s.n} latitude`,
    );
    assert.ok(
      Number.isFinite(s.x) && s.x >= -180 && s.x <= 180,
      `station ${s.n} longitude`,
    );
    assert.ok(s.r.length > 0, `station ${s.n} links to no route`);
  }
});

check("city groups point at real stations", () => {
  assert.ok(payload.groups.length > 0);
  for (const g of payload.groups) {
    assert.ok(g.n, "group without a display name");
    assert.ok(
      Number.isFinite(g.y) && Number.isFinite(g.x),
      `group ${g.n} coordinates`,
    );
    assert.ok(g.s.length > 0, `group ${g.n} has no members`);
    for (const i of g.s) {
      assert.ok(
        Number.isInteger(i) && i >= 0 && i < payload.stations.length,
        `group ${g.n} references station index ${i}, out of ${payload.stations.length}`,
      );
    }
  }
});

check("a grouped marker sits near its own members", () => {
  // The Florence-in-the-Atlantic bug: a name bucket spanning two continents
  // averaged to a point in the ocean. groupCityMarkers clusters at 60 km, so no
  // member may be far from its marker.
  for (const g of payload.groups) {
    for (const i of g.s) {
      const s = payload.stations[i];
      const d = distanceKm(g.y, g.x, s.y, s.x);
      assert.ok(
        d <= 120,
        `group ${g.n} sits ${d.toFixed(0)} km from member ${s.n} — proximity clustering failed`,
      );
    }
  }
});

check("disabled routes are absent", () => {
  const disabled = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "data/overrides/disabled-routes.json"),
      "utf8",
    ),
  );
  const ids = new Set(payload.routes.map((r) => r.id));
  for (const id of disabled) {
    assert.ok(
      !ids.has(String(id)),
      `disabled route ${id} is still in the payload`,
    );
  }
});

check("every route a station links to is either present or disabled", () => {
  const disabled = new Set(
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "data/overrides/disabled-routes.json"),
        "utf8",
      ),
    ).map(String),
  );
  const present = new Set(payload.routes.map((r) => r.id));
  const dangling = new Set();
  for (const s of payload.stations) {
    for (const id of s.r) {
      if (!present.has(id) && !disabled.has(id)) dangling.add(id);
    }
  }
  assert.strictEqual(
    dangling.size,
    0,
    `stations link to routes that carry no geometry: ${[...dangling].slice(0, 8).join(", ")}`,
  );
});

check("simplification stays within tolerance of the original line", () => {
  // The reduction is only safe if the simplified line still follows the track.
  // Sample the densest routes and confirm every dropped point is close to the
  // segment that replaced it.
  const original = [
    [50.0, 14.0],
    [50.1, 14.05],
    [50.2, 14.11],
    [50.3, 14.14],
    [50.4, 14.2],
  ];
  const out = simplifyPath(original, 1e-2);
  for (const p of original) {
    let best = Infinity;
    for (let i = 0; i < out.length - 1; i += 1) {
      const [ay, ax] = out[i];
      const [by, bx] = out[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p[1] - ax) * dx + (p[0] - ay) * dy) / (dx * dx + dy * dy),
        ),
      );
      best = Math.min(
        best,
        Math.hypot(p[1] - (ax + t * dx), p[0] - (ay + t * dy)),
      );
    }
    assert.ok(
      best <= 1e-2 + 1e-9,
      `point ${JSON.stringify(p)} is ${best} from the line`,
    );
  }
});

check("geometry simplification actually paid for itself", () => {
  assert.ok(
    stats.pointsOut < stats.pointsIn * 0.5,
    `only ${stats.pointsIn - stats.pointsOut} of ${stats.pointsIn} points removed`,
  );
});

check("no geometry key was left unresolved", () => {
  assert.deepStrictEqual(
    stats.unresolved,
    [],
    `unresolved OSM/static geometry: ${stats.unresolved.join(", ")} — ` +
      `those routes silently fall back to a straight station chain`,
  );
});

check("committed payload matches a fresh build", () => {
  // Same contract as verify-build-parity: a PR that changes the merge inputs
  // has to regenerate the artifact, or the app ships stale data.
  const file = path.join(ROOT, "public/data/published/mobile-v1.json");
  assert.ok(
    fs.existsSync(file),
    "public/data/published/mobile-v1.json is missing",
  );
  const committed = JSON.parse(fs.readFileSync(file, "utf8"));

  // generatedAt differs by construction; everything else must not.
  const strip = (p) => JSON.stringify({ ...p, generatedAt: null });
  assert.strictEqual(
    strip(committed),
    strip(payload),
    "the committed mobile-v1.json differs from a fresh build — run `npm run build-mobile-payload`",
  );
});

const gzip = zlib.gzipSync(Buffer.from(json), { level: 9 }).length;
console.log(
  `[verify-mobile-payload] ${passed} checks passed ` +
    `(${(json.length / 1024).toFixed(0)} KB raw / ${(gzip / 1024).toFixed(0)} KB gzip, ` +
    `${payload.routes.length} routes, ${payload.stations.length} stations)`,
);
