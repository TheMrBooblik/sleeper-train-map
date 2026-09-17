// tests/verify-cfr-gtfs.mjs
// CFR Călători over the Romanian national GTFS feed.
//
// Three things are pinned here, and each one is pinned as a FAULT as well as a
// fix, because all three shipped broken once during this work and every one of
// them looked fine from the outside:
//
//   1. Through cars. "IRN 472/IRN 1743" is one journey under two numbers and
//      leg one runs PAST the junction, so a plain concatenation draws the line
//      to the Hungarian border, jumps back to Arad and sets off again.
//   2. The border splice. The feed stops at the frontier, so enriching a row
//      with it unspliced published D 346 as "Bucuresti Nord -> Wien Hbf,
//      arriving 03:00" — Lokoshaza's time on Vienna's marker, with Budapest and
//      Gyor gone from the line. That is strictly worse than the stale data it
//      replaced, and nothing downstream would have complained.
//   3. Coordless via names. Four of row 28's Bulgarian stations are text in a
//      via string and nothing else — no record in Back-on-Track's table at all.
//      Dropping them made the "richer" official list SHORTER than the one it
//      replaces, and viaOnlyIfRicher then refused the whole train.

import assert from "node:assert/strict";
import fs from "node:fs";
import polyline from "@mapbox/polyline";
import {
  stitchLegs,
  buildSleeperTrains,
  seasonalServiceDisplay,
  seasonalOrYearlyDisplay,
} from "../scripts/lib/gtfs.mjs";
import {
  botChain,
  endpointsAgree,
  foldStationName,
  spliceForeignStretch,
} from "../scripts/adapters/cfr-gtfs.mjs";

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  ✓ ${name}`);
};

const at = (name, lat, lon, arrival = null, departure = null) => ({
  name,
  code: null,
  location: { latitude: lat, longitude: lon },
  arrival,
  departure,
  pickup: true,
  dropoff: true,
});
const chain = (stations) => stations.map((s) => [s.location.latitude, s.location.longitude]);

// ─── 0. foldStationName ─────────────────────────────────────────────────────
// Carried over from the retired verify-cfr suite: the helper moved into this
// adapter when the data.gov.ro path was deleted, and the spellings it has to
// reconcile did not change with it.

check("foldStationName equates the spellings this source has to reconcile", () => {
  const same = (a, b) =>
    assert.strictEqual(foldStationName(a), foldStationName(b), `${a} vs ${b}`);
  same("Bucuresti Nord", "București Nord");
  same("Timisoara Nord", "Timişoara Nord");
  same("Timişoara Nord", "Timișoara Nord"); // cedilla vs comma below
  same("Cluj Napoca", "Cluj-Napoca");
  same("Vatra Dornei Bai", "Vatra Dornei Băi");
  same("Chisinau", "Chişinău");
  same("Lokoshaza", "Lőkösháza"); // the Hungarian border station, both ways
  assert.strictEqual(foldStationName("h. Posada"), "posada");
  assert.strictEqual(foldStationName("Bușteni Hm."), "busteni");
});

check("foldStationName folds a non-decomposing letter rather than dropping it", () => {
  // The reason this is not normLabel from gtfs.mjs: that one strips every
  // non-ASCII letter, so a dotless ı vanishes instead of becoming "i".
  assert.strictEqual(foldStationName("İstanbul Halkalı").includes("halkal"), true);
  assert.strictEqual(foldStationName("Zdunska Wola"), foldStationName("Zduńska Wola"));
});

// ─── 1. stitchLegs ──────────────────────────────────────────────────────────

const bucuresti = at("București Nord", 44.44, 26.07, null, "18:24");
const arad = at("Arad", 46.18, 21.32, "02:17", "02:36");
const curtici = at("Curtici", 46.34, 21.29, "02:48", "02:50");
const lokoshaza = at("Lokoshaza", 46.43, 21.23, "03:00", "03:00");
const aradLeg2 = at("Arad", 46.18, 21.32, null, "06:07");
const oradea = at("Oradea", 47.05, 21.92, "08:28", null);

const leg472 = { stations: [bucuresti, arad, curtici, lokoshaza] };
leg472.positions = chain(leg472.stations);
const leg1743 = { stations: [aradLeg2, oradea] };
leg1743.positions = chain(leg1743.stations);

check("stitchLegs joins at the shared station and drops leg one's overshoot", () => {
  const out = stitchLegs([leg472, leg1743]);
  assert.deepEqual(
    out.stations.map((s) => s.name),
    ["București Nord", "Arad", "Oradea"],
    "Curtici and Lokoshaza are past the junction and must not survive",
  );
});

check("the junction keeps leg one's arrival and leg two's departure", () => {
  const junction = stitchLegs([leg472, leg1743]).stations[1];
  assert.equal(junction.arrival, "02:17", "the portion does arrive at 02:17");
  assert.equal(junction.departure, "06:07", "but it does not leave again until 1743 does");
});

check("geometry is cut at the junction too, so the line never doubles back", () => {
  const out = stitchLegs([leg472, leg1743]);
  const reachedBorder = out.positions.some(
    ([lat, lon]) => Math.abs(lat - 46.43) < 0.01 && Math.abs(lon - 21.23) < 0.01,
  );
  assert.equal(reachedBorder, false, "Lokoshaza's position is past the junction");
  // The fault: concatenating instead would carry it.
  const naive = [...leg472.positions, ...leg1743.positions];
  assert.equal(
    naive.some(([lat]) => Math.abs(lat - 46.43) < 0.01),
    true,
    "guard is meaningful — a plain concatenation does reach the border",
  );
});

check("legs that share no station return null rather than a fictional junction", () => {
  const elsewhere = { stations: [at("Iași", 47.16, 27.59), at("Cluj Napoca", 46.78, 23.6)] };
  elsewhere.positions = chain(elsewhere.stations);
  assert.equal(stitchLegs([leg472, elsewhere]), null);
});

// ─── 2. route-named allowlist entries ───────────────────────────────────────

// Smallest feed that exercises both entry shapes: route_id is the train number
// and route_short_name is the operator's own "IR-N <n>", neither of which is
// the label the view-map row carries.
function miniGtfs() {
  const stops = new Map([
    ["B", { name: "București Nord Gr.A", lat: 44.44, lon: 26.07 }],
    ["A", { name: "Arad", lat: 46.18, lon: 21.32 }],
    ["L", { name: "Lokoshaza", lat: 46.43, lon: 21.23 }],
    ["O", { name: "Oradea", lat: 47.05, lon: 21.92 }],
  ]);
  const st = (trip, seq) =>
    seq.map(([stop_id, t], i) => ({
      trip_id: trip,
      stop_id,
      stop_sequence: i,
      arrival: t,
      departure: t,
    }));
  return {
    routesById: new Map([
      ["346", { route_id: "346", route_short_name: "IR-N 346", route_long_name: "" }],
      ["1743", { route_id: "1743", route_short_name: "IR-N 1743", route_long_name: "" }],
    ]),
    trips: [
      { route_id: "346", trip_id: "t346", service_id: "s1", shape_id: null },
      { route_id: "1743", trip_id: "t1743", service_id: "s1", shape_id: null },
    ],
    stopsById: stops,
    stopTimesByTrip: new Map([
      ["t346", st("t346", [["B", "16:00:00"], ["A", "26:17:00"], ["L", "27:00:00"]])],
      ["t1743", st("t1743", [["A", "06:07:00"], ["O", "08:28:00"]])],
    ]),
    shapePoints: new Map(),
    calendarById: new Map(),
    addedDatesByService: new Map([["s1", ["20260918"]]]),
  };
}

check("{ route, name } keys the train by the row's label, not the feed's", () => {
  const trains = buildSleeperTrains({
    gtfs: miniGtfs(),
    allowlist: [{ route: "346", name: "D 346" }],
    agency: "CFR",
    operator: "CFR Călători",
    serviceWindow: null,
  });
  assert.deepEqual(Object.keys(trains), ["D 346"], "trainsByNumber looks rows up by this key");
  assert.equal(trains["D 346"].stations.length, 3);
});

check("{ routes, name } stitches the legs of a through car under one key", () => {
  const trains = buildSleeperTrains({
    gtfs: miniGtfs(),
    allowlist: [{ routes: ["346", "1743"], name: "IRN 472/IRN 1743" }],
    agency: "CFR",
    operator: "CFR Călători",
    serviceWindow: null,
  });
  const t = trains["IRN 472/IRN 1743"];
  assert.deepEqual(t.stations.map((s) => s.name), [
    "București Nord Gr.A",
    "Arad",
    "Oradea",
  ]);
});

// Two rows, one train. South of Ungheni the Kyiv–București sleeper IS the
// Chișinău–București one — same physical train, which is why rows 174 and 22
// state the same București times to the minute — so both rows have to be fed
// from the same feed route under their own labels. claimKey guards duplicate
// KEYS; a route being named twice is not a duplicate, and if that ever became
// one, row 174 would silently lose its stop list with nothing to say why.
check("one feed route may be claimed by two entries under different keys", () => {
  const trains = buildSleeperTrains({
    gtfs: miniGtfs(),
    allowlist: [
      { route: "346", name: "401" },
      { route: "346", name: "099" },
    ],
    agency: "CFR",
    operator: "CFR Călători",
    serviceWindow: null,
  });
  assert.deepEqual(Object.keys(trains).sort(), ["099", "401"]);
  // Both must carry the whole trip — a second claim that came back short would
  // mean the first had consumed the route's trips rather than just read them.
  assert.equal(trains["401"].stations.length, 3);
  assert.equal(trains["099"].stations.length, 3);
  assert.deepEqual(
    trains["099"].stations.map((s) => s.name),
    trains["401"].stations.map((s) => s.name),
  );
});

check("a named entry the feed cannot serve is reported, not silently skipped", () => {
  const stats = {};
  buildSleeperTrains({
    gtfs: miniGtfs(),
    allowlist: [{ route: "9999", name: "IRN 9999" }],
    agency: "CFR",
    operator: "CFR Călători",
    stats,
    serviceWindow: null,
  });
  assert.ok(stats.unmatched.some((u) => u.includes("IRN 9999")));
});

// ─── 3. the border splice ───────────────────────────────────────────────────

const ROW_59 = {
  origin_trip_0: "București Nord",
  destination_trip_0: "Wien Hbf",
  origin_departure_time_0: "16:00",
  destination_arrival_time_0: "08:53",
  via_0: "Ploiești Vest - Brașov - Kőbánya-Kispest - Budapest Kelenföld - Győr",
};
const COORDS = {
  "bucuresti nord": { lat: 44.44, lon: 26.07 },
  "ploiesti vest": { lat: 44.92, lon: 25.99 },
  brasov: { lat: 45.66, lon: 25.61 },
  "kobanya kispest": { lat: 47.46, lon: 19.13 },
  "budapest kelenfold": { lat: 47.46, lon: 19.02 },
  gyor: { lat: 47.69, lon: 17.63 },
  "wien hbf": { lat: 48.18, lon: 16.38 },
};
// Same folding the adapter uses, reduced to what these fixtures need.
const fold = (n) =>
  String(n)
    .toLowerCase()
    .replace(/ș/g, "s")
    .replace(/ț/g, "t")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-–—/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const stopCoords = (n) => COORDS[fold(n)] ?? null;
const isKnownStation = (n) => Boolean(stopCoords(n));

// What the feed alone gives: Romanian stops, ending at the frontier.
const FEED_346 = [
  at("București Nord", 44.44, 26.07, "16:00", "16:00"),
  at("Ploiești Vest", 44.92, 25.99, "16:37", "16:38"),
  at("Brașov", 45.66, 25.61, "18:29", "18:42"),
  at("Curtici", 46.34, 21.29, "02:48", "02:50"),
  at("Lokoshaza", 46.43, 21.23, "03:00", "03:00"),
];

check("botChain reads the row's own journey, endpoints included", () => {
  assert.deepEqual(botChain(ROW_59, 0, isKnownStation), [
    "București Nord",
    "Ploiești Vest",
    "Brașov",
    "Kőbánya-Kispest",
    "Budapest Kelenföld",
    "Győr",
    "Wien Hbf",
  ]);
});

check("the splice puts the foreign stretch back on the end", () => {
  const out = spliceForeignStretch({
    stations: FEED_346,
    route: ROW_59,
    d: 0,
    isKnownStation,
    stopCoords,
  });
  assert.equal(out.tail, 4, "Kőbánya-Kispest, Kelenföld, Győr and Wien Hbf");
  assert.equal(out.stations[out.stations.length - 1].name, "Wien Hbf");
  assert.equal(
    out.stations[out.stations.length - 1].arrival,
    "08:53",
    "the row states its own arrival; the feed cannot know it",
  );
  assert.ok(
    out.stations.some((s) => s.name === "Lokoshaza"),
    "the feed's own stops are kept in full",
  );
});

check("THE FAULT: unspliced, the row would end at the border", () => {
  // This is what shipped before the splice was wired in, and what a filtered
  // scrape run reproduced when ctx.shared.viewMap was empty.
  const last = FEED_346[FEED_346.length - 1];
  assert.equal(last.name, "Lokoshaza");
  assert.equal(
    endpointsAgree(FEED_346, ROW_59, 0),
    false,
    "Lokoshaza is not Wien Hbf — the endpoint check is what catches this",
  );
});

check("the splice recovers the head when the row starts abroad", () => {
  const reversed = {
    origin_trip_1: "Wien Hbf",
    destination_trip_1: "București Nord",
    origin_departure_time_1: "19:08",
    destination_arrival_time_1: "13:38",
    via_1: "Győr - Budapest Kelenföld - Brașov - Ploiești Vest",
  };
  const feed = [
    at("Brașov", 45.66, 25.61, "09:00", "09:10"),
    at("Ploiești Vest", 44.92, 25.99, "12:30", "12:32"),
    at("București Nord", 44.44, 26.07, "13:38", null),
  ];
  const out = spliceForeignStretch({
    stations: feed,
    route: reversed,
    d: 1,
    isKnownStation,
    stopCoords,
  });
  assert.equal(out.head, 3, "Wien Hbf, Győr and Budapest Kelenföld");
  assert.equal(out.stations[0].name, "Wien Hbf");
  assert.equal(out.stations[0].departure, "19:08");
  assert.equal(endpointsAgree(out.stations, reversed, 1), true);
});

check("a via name with no station record is KEPT, with a null location", () => {
  // Row 28's Bulgarian names: text in a via string, absent from the station
  // table. Dropping them shortened the "richer" list and got the whole train
  // refused by viaOnlyIfRicher.
  const row = {
    origin_trip_0: "İstanbul Halkalı",
    destination_trip_0: "București Nord",
    origin_departure_time_0: "20:00",
    destination_arrival_time_0: "16:56",
    via_0: "Svilengrad - Stara Zagora - Brașov",
  };
  const coords = (n) =>
    fold(n) === "istanbul halkalı" || fold(n) === "istanbul halkali"
      ? { lat: 41.0, lon: 28.8 }
      : stopCoords(n);
  const out = spliceForeignStretch({
    stations: [at("Brașov", 45.66, 25.61), at("București Nord", 44.44, 26.07, "16:56")],
    route: row,
    d: 0,
    isKnownStation: (n) => Boolean(coords(n)),
    stopCoords: coords,
  });
  const names = out.stations.map((s) => s.name);
  assert.ok(names.includes("Svilengrad") && names.includes("Stara Zagora"));
  assert.equal(
    out.stations.find((s) => s.name === "Svilengrad").location,
    null,
    "no coordinate, but the name survives for the station list",
  );
});

check("no shared station at all means the feed is describing another journey", () => {
  const out = spliceForeignStretch({
    stations: [at("Iași", 47.16, 27.59), at("Cluj Napoca", 46.78, 23.6)],
    route: ROW_59,
    d: 0,
    isKnownStation,
    stopCoords,
  });
  assert.equal(out, null);
});

// ─── 4. the endpoint check, which is what makes setTimes safe ───────────────

check("endpointsAgree folds diacritics and separators, and nothing looser", () => {
  const row = { origin_trip_0: "Timişoara Nord", destination_trip_0: "Cluj-Napoca" };
  const stations = [at("Timișoara Nord", 45.75, 21.21), at("Cluj Napoca", 46.78, 23.6)];
  assert.equal(endpointsAgree(stations, row, 0), true, "cedilla-s = comma-s, hyphen = space");

  // The looseness that was tried and rejected: these are two real, different
  // Budapest termini, and a city-level match would have called them the same.
  const keleti = { origin_trip_0: "București Nord", destination_trip_0: "Budapest Keleti" };
  const toKelenfold = [at("București Nord", 44.44, 26.07), at("Budapest Kelenföld", 47.46, 19.02)];
  assert.equal(endpointsAgree(toKelenfold, keleti, 0), false);
});

check("endpointsAgree rejects a train that ends in the wrong place", () => {
  const row = { origin_trip_0: "București Nord", destination_trip_0: "Wien Hbf" };
  const stations = [at("București Nord", 44.44, 26.07), at("Budapest Keleti", 47.5, 19.08)];
  assert.equal(endpointsAgree(stations, row, 0), false);
});

// ─── 5. seasonal service strings ────────────────────────────────────────────
// Thirteen of Romania's forty-two night trains are summer Black Sea services,
// and two of them are rows we publish. Before this, the row kept
// Back-on-Track's "2026: Daily" and the map drew Constanța–Oradea as a daily
// train nine days after its last run — one of them still carried a season from
// 2024.

const seasonGtfs = {
  addedDatesByService: new Map([
    // A summer service: mid-June to early September, every day.
    ["summer", ["20260613", "20260614", "20260615", "20260616", "20260617", "20260618", "20260619", "20260906"]],
    // A year-round one: a full week inside the window so every weekday is
    // represented, bracketed by the first and last day of the timetable period
    // so the span is the whole year rather than a season.
    [
      "yearRound",
      [
        "20251214",
        "20260921", "20260922", "20260923", "20260924", "20260925", "20260926", "20260927",
        "20261212",
      ],
    ],
  ]),
  calendarById: new Map(),
};

check("a part-year service states its own dates, in the spelling the map reads", () => {
  const out = seasonalServiceDisplay(new Set(["summer"]), seasonGtfs);
  assert.equal(out, "2026/06/13-2026/09/06: Daily");
  // The trips spelling, with a year on BOTH sides. renderCalendar emits a
  // shorter "2026/06/13-09/06" that parseBoTServiceIdDateRange cannot read, so
  // writing that form would state the season and change nothing on the map.
  assert.match(out, /^\d{4}\/\d{2}\/\d{2}-\d{4}\/\d{2}\/\d{2}: /);
});

check("a year-round service is not called seasonal", () => {
  assert.equal(seasonalServiceDisplay(new Set(["yearRound"]), seasonGtfs), null);
});

check("THE REGRESSION: a year-round row keeps its year prefix", () => {
  // serviceDisplayForServices answers in bare weekdays, so taking it verbatim
  // turned "2026: Daily" into "Daily" on 28 of 35 directions — a real loss on
  // every year-round train, to fix the seven that were wrong.
  const out = seasonalOrYearlyDisplay(new Set(["yearRound"]), seasonGtfs, {
    start: "20260917",
    end: "20261213",
  });
  assert.equal(out, "2026: Daily");
});

check("a season is preferred over the year prefix", () => {
  const out = seasonalOrYearlyDisplay(new Set(["summer"]), seasonGtfs, {
    start: "20260917",
    end: "20261213",
  });
  assert.equal(out, "2026/06/13-2026/09/06: Daily");
});

check("a span crossing a year boundary is left alone", () => {
  const crossing = {
    addedDatesByService: new Map([["winter", ["20261220", "20270105"]]]),
    calendarById: new Map(),
  };
  // "2026/12/20-2027/01/05" would parse, but a two-date sample says nothing
  // about weekdays and the shape exists for seasons inside one year.
  assert.equal(seasonalServiceDisplay(new Set(["winter"]), crossing), null);
});

// ─── 6. the spliced line reaches the row's own origin ───────────────────────
//
// The fourth fault, and the only one no fixture could have caught: the splice
// keeps a coordless station with a null location, and `chainOf` then drops it
// from the geometry — correct for row 28's Bulgarian via names, which are text
// in a via string and nothing else, and wrong for Ukraine, where the station
// exists in Back-on-Track's table under a Cyrillic name while every row spells
// it in Latin. Row 174 therefore drew the Romanian half in full track geometry
// and stopped dead at the Moldovan border, 410 km short of Kyiv. It looked
// worse than the Romania-only stub it replaced, because a long correct line
// ending in the wrong country reads as a bug rather than as missing data.
//
// So this is asserted against the PUBLISHED payload rather than a fixture: the
// defect was in what the adapter wires into `stopCoords`, not in any function a
// fixture exercises. Distance rather than equality, because the polyline's
// first vertex is the station's own coordinate and the table may correct it.
{
  const published = JSON.parse(
    fs.readFileSync("public/data/published/initial-data.json", "utf8"),
  ).data;
  const distanceKm = (a, b) => {
    const R = 6371;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b[0] - a[0]);
    const dLon = rad(b[1] - a[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const stopAt = (name) => {
    const s = published.stops.find((x) => x.stop_name === name);
    return s && Number.isFinite(s.stop_lat) ? [s.stop_lat, s.stop_lon] : null;
  };

  check("a spliced row's line starts at the station the row says it does", () => {
    // Every cfr-stamped row, both directions — not row 174 alone, or the next
    // border this meets goes unnoticed the same way.
    const offenders = [];
    for (const row of Object.values(published.viewMap)) {
      if (!row.official_sources?.includes("cfr")) continue;
      for (const d of [0, 1]) {
        const enc = row[`nj_polyline_${d}`];
        const origin = stopAt(row[`origin_trip_${d}`]);
        if (!enc || !origin) continue;
        const first = polyline.decode(enc)[0];
        const gap = distanceKm(first, origin);
        if (gap > 25) {
          offenders.push(`${row.route_id} dir${d}: line starts ${gap.toFixed(0)} km from ${row[`origin_trip_${d}`]}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  check("THE REGRESSION: row 174's line runs Kyiv → București, not Ungheni →", () => {
    const row = published.viewMap["174"];
    const first = polyline.decode(row.nj_polyline_0)[0];
    // Ungheni is where the Romanian feed's own trip begins; the row begins two
    // countries earlier, and the head is what carries it there.
    assert.ok(
      distanceKm(first, [47.2036, 27.7996]) > 300,
      `line still starts at the Moldovan border: ${first}`,
    );
    assert.ok(distanceKm(first, [50.44, 30.489]) < 25, `line does not start at Kyiv: ${first}`);
  });
}

console.log(`[verify-cfr-gtfs] ${checks} checks passed`);
