// tests/verify-trafiklab.mjs
// Sweden's night trains from Trafiklab's GTFS Sweden 3 (scripts/adapters/
// trafiklab-gtfs.mjs). Each rule below is pinned against the case in the real
// feed that made it necessary, so the fixtures read like the feed of
// 2026-09-25 rather than like invented data:
//
//   1. Names are accepted from Back-on-Track only where its coordinate agrees
//      with the feed's — "Boden" sits 2 271 km from Boden there.
//   2. A season is a train stopping well short of the feed's horizon, never
//      the horizon itself, and its start comes from the row when the feed
//      begins mid-season.
//   3. The representative run is the modal pattern by dates, and a sleeper
//      portion listed beside its through train must not win on a tie.
//   4. Stations abroad the feed skips (Hamburg) come back; Swedish ones never
//      do, and a same-city station is not a stop.
//   5. The committed artifacts carry all of it.
//
// Plus the streamed reader the 698 MB stop_times.txt goes through.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import polyline from "@mapbox/polyline";
import { streamZipCsv, headersFor } from "../scripts/lib/gtfs.mjs";
import {
  nameCandidates,
  makeStationNamer,
  renderServiceDays,
  rowSeasonStart,
  weekdayList,
  pickRepresentativeRun,
  fillForeignGaps,
  orientedChain,
  serviceDatesById,
  pickServiceWindow,
  fmtTime,
  buildTrafiklabTrains,
  alignLabelsWithRows,
} from "../scripts/adapters/trafiklab-gtfs.mjs";
import { sourceFeedSchedule, sourceFeedIdForRoute } from "../src/lib/sourceFeedSchedule.mjs";

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks++;
  console.log(`  ✓ ${name}`);
};

// ─── 1. Station names ───────────────────────────────────────────────────────

await check("feed spellings map to the dataset's", () => {
  assert.equal(nameCandidates("Umeå Centralstation")[0], "Umeå C");
  assert.equal(nameCandidates("Uppsala Centralstation Tåg")[0], "Uppsala C");
  assert.ok(nameCandidates("Härnösand Central").includes("Härnösands central"));
  assert.ok(nameCandidates("Hudiksvalls station").includes("Hudiksvall"), "Swedish genitive");
  assert.equal(nameCandidates("Berlin Hbf (Tief)")[0], "Berlin Hbf");
  assert.equal(nameCandidates("Köbenhavn Syd")[0], "København Syd");
  assert.equal(nameCandidates("Boden Resecentrum Tät")[0], "Boden");
});

const botStops = {
  a: { stop_id: "Boden", stop_name: "Boden", stop_lat: 45.9, stop_lon: 7.3, stop_country: "SE" },
  b: { stop_id: "Boden C", stop_name: "Boden C", stop_lat: 65.8256, stop_lon: 21.6883, stop_country: "SE" },
  c: { stop_id: "Stockholm C", stop_name: "Stockholm C", stop_lat: 59.3299, stop_lon: 18.0566, stop_country: "SE" },
  d: { stop_id: "Stockholms central", stop_name: "Stockholms central", stop_lat: 48.2, stop_lon: 16.4, stop_country: "SE" },
  e: { stop_id: "Södertälje syd övre", stop_name: "Södertälje syd övre", stop_lat: 59.1628, stop_lon: 17.6456, stop_country: "SE" },
  f: { stop_id: "Hamburg Hbf", stop_name: "Hamburg Hbf", stop_lat: 53.5528, stop_lon: 10.0069, stop_country: "DE" },
  g: { stop_id: "Berlin Hbf", stop_name: "Berlin Hbf", stop_lat: 52.5251, stop_lon: 13.3694, stop_country: "DE" },
  h: { stop_id: "København Syd", stop_name: "København Syd", stop_lat: 55.6525, stop_lon: 12.5167, stop_country: "DK" },
  i: { stop_id: "Malmö C", stop_name: "Malmö C", stop_lat: 55.6093, stop_lon: 13.0007, stop_country: "SE" },
  j: { stop_id: "Lund C", stop_name: "Lund C", stop_lat: 55.7058, stop_lon: 13.1868, stop_country: "SE" },
  k: { stop_id: "Hässleholm C", stop_name: "Hässleholm C", stop_lat: 56.1587, stop_lon: 13.7627, stop_country: "SE" },
  l: { stop_id: "Kramfors", stop_name: "Kramfors", stop_lat: 40.0, stop_lon: -3.0, stop_country: "ES" },
};

await check("a Back-on-Track name is taken only where its coordinate agrees", () => {
  const namer = makeStationNamer({ botStops });
  // "Boden" exists, 2 271 km away; "Boden C" is the station.
  assert.equal(namer({ name: "Boden Resecentrum Tät", lat: 65.8255, lon: 21.6893 }).name, "Boden C");
  // "Stockholms central" exists too, and is in Austria.
  assert.equal(namer({ name: "Stockholm Centralstation", lat: 59.3315, lon: 18.0549 }).name, "Stockholm C");
  // A longer name starting with ours, standing where ours stands.
  assert.equal(namer({ name: "Södertälje syd station", lat: 59.1629, lon: 17.6451 }).name, "Södertälje syd övre");
  const fresh = namer({ name: "Nordmaling Resecentrum", lat: 63.578, lon: 19.486 });
  assert.deepEqual([fresh.name, fresh.matched], ["Nordmaling", false], "new station keeps its own name");
});

await check("a name taken by a station elsewhere is reported, not silently drawn there", () => {
  const namer = makeStationNamer({ botStops });
  const hit = namer({ name: "Kramfors ReseC", lat: 62.928, lon: 17.78 });
  assert.equal(hit.matched, false);
  assert.ok(hit.collision && hit.collision.km > 2000, "collision surfaced with its distance");
});

await check("coordinate overrides are what the match is judged against", () => {
  const namer = makeStationNamer({ botStops, coordOverrides: { Boden: { lat: 65.8255, lon: 21.6893 } } });
  assert.equal(namer({ name: "Boden Resecentrum Tät", lat: 65.8255, lon: 21.6893 }).name, "Boden");
});

// ─── 2. Service days ────────────────────────────────────────────────────────

const span = (from, to, weekdays) => {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (weekdays.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return out;
};
const ALL = [0, 1, 2, 3, 4, 5, 6];

await check("a train running to the feed's horizon is yearly, not a season ending at the horizon", () => {
  const dates = span("2026-09-26", "2026-12-11", ALL);
  assert.equal(renderServiceDays(dates, { horizonStart: "20260926", horizonEnd: "20261211" }), "2026: Daily");
});

await check("SJ 1 does not run on Saturdays, and says so", () => {
  const dates = span("2026-09-27", "2026-12-11", [0, 1, 2, 3, 4, 5]);
  assert.equal(
    renderServiceDays(dates, { horizonStart: "20260926", horizonEnd: "20261211" }),
    "2026: Mon, Tue, Wed, Thu, Fri, Sun",
  );
});

await check("a season ending short of the horizon keeps the row's start, not the feed's", () => {
  // Snälltåget 24 (Back-on-Track 3920): Wed/Sat until 3 October, while every
  // other train runs to 11 December. The feed begins mid-season.
  const dates = ["20260926", "20260930", "20261003"];
  const opts = { horizonStart: "20260926", horizonEnd: "20261211" };
  assert.equal(
    renderServiceDays(dates, { ...opts, rowSeasonStart: rowSeasonStart("2026/06/25-09/27: Wed, Sat") }),
    "2026/06/25-2026/10/03: Wed, Sat",
  );
  // Without a row to ask, the fault this guards: an eleven-day "season".
  assert.equal(renderServiceDays(dates, opts), "2026/09/26-2026/10/03: Wed, Sat");
});

await check("a season that starts inside the feed uses its own first date", () => {
  const dates = span("2026-10-20", "2026-11-15", [3, 6]);
  assert.equal(
    renderServiceDays(dates, { horizonStart: "20260926", horizonEnd: "20261211", rowSeasonStart: "20260601" }),
    "2026/10/21-2026/11/14: Wed, Sat",
  );
});

await check("a works diversion on one odd weekday does not add that weekday", () => {
  const dates = [...span("2026-09-27", "2026-12-11", [0, 1, 2, 3, 4, 5]), "20261010"];
  assert.equal(weekdayList(dates), "Mon, Tue, Wed, Thu, Fri, Sun");
  // …while a weekday that runs for part of the period still counts (Snälltåget
  // 300 runs Tue/Wed only until November: 5 of 11 weeks).
  const partial = [...span("2026-09-27", "2026-12-11", [0, 1, 4, 5]), ...span("2026-09-27", "2026-10-28", [2, 3])];
  assert.equal(weekdayList(partial), "Mon, Tue, Wed, Thu, Fri, Sun");
});

await check("calendar.txt spans and calendar_dates exceptions both produce dates", () => {
  const byId = serviceDatesById(
    [{ service_id: "w", monday: "1", tuesday: "0", wednesday: "0", thursday: "0", friday: "0", saturday: "0", sunday: "0", start_date: "20260928", end_date: "20261012" }],
    [
      { service_id: "w", date: "20261005", exception_type: "2" },
      { service_id: "x", date: "20261001", exception_type: "1" },
    ],
  );
  assert.deepEqual([...byId.get("w")].sort(), ["20260928", "20261012"]);
  assert.deepEqual([...byId.get("x")], ["20261001"]);
});

await check("the last fortnight of a period is described by the next one, when the feed has it", () => {
  const w = pickServiceWindow("2026-12-05", new Set(["20261206", "20261214", "20270110"]));
  assert.equal(w.start, "20261213");
  const stay = pickServiceWindow("2026-12-05", new Set(["20261206"]));
  assert.equal(stay.start, "20261205", "no next-period data: keep the current one");
  assert.equal(pickServiceWindow("2026-09-26", new Set()).end, "20261213");
});

await check("times past midnight wrap", () => {
  assert.equal(fmtTime("30:59:00"), "06:59");
  assert.equal(fmtTime("23:17:00"), "23:17");
  assert.equal(fmtTime(""), null);
});

// ─── 3. Representative run ──────────────────────────────────────────────────

const run = (id, stations, dates, time = "22:00:00") => ({
  tripId: id,
  stops: stations.map((s) => ({ station: s, arrival: time, departure: time })),
  dates: new Set(dates),
});

await check("the through train beats its sleeper portion on a tie, a rare detour never wins", () => {
  const nights = span("2026-09-27", "2026-12-11", [0, 1, 4, 5]);
  const portion = run("p", ["Berlin", "København", "Malmö"], nights);
  const through = run("t", ["Berlin", "København", "Malmö", "Lund", "Stockholm"], nights);
  const dresden = run("d", ["Dresden", "Berlin", "København", "Malmö", "Lund", "Nässjö", "Stockholm"], nights.slice(0, 7));
  assert.equal(pickRepresentativeRun([portion, dresden, through]).tripId, "t");
});

await check("within the pattern, the timing that runs most wins", () => {
  const stops = ["Stockholm", "Norrköping", "Malmö"];
  const usual = run("usual", stops, span("2026-09-27", "2026-11-30", ALL), "23:17:00");
  const works = run("works", stops, span("2026-12-01", "2026-12-06", ALL), "22:47:00");
  assert.equal(pickRepresentativeRun([works, usual]).tripId, "usual");
});

// ─── 4. Stations abroad ─────────────────────────────────────────────────────

const botStation = (name) => {
  const s = Object.values(botStops).find((x) => x.stop_name === name);
  return s ? { lat: s.stop_lat, lon: s.stop_lon, country: s.stop_country } : null;
};
const st = (name, lat, lon) => ({ name, location: { latitude: lat, longitude: lon } });

await check("Hamburg comes back between København and Berlin; Berlin Hbf does not precede Gesundbrunnen", () => {
  const feed = [
    st("Malmö C", 55.609, 13.0),
    st("København Syd", 55.6525, 12.5167),
    st("Berlin Gesundbrunnen", 52.5489, 13.3886),
  ];
  const chain = ["Stockholm C", "Lund C", "Malmö C", "København Syd", "Hamburg Hbf", "Berlin Hbf"];
  const { stations, inserted } = fillForeignGaps(feed, chain, botStation);
  assert.deepEqual(inserted, ["Hamburg Hbf"]);
  assert.deepEqual(stations.map((s) => s.name), ["Malmö C", "København Syd", "Hamburg Hbf", "Berlin Gesundbrunnen"]);
  assert.equal(stations[2].arrival, null, "a borrowed station carries no invented time");
});

await check("a Swedish station the feed leaves out is never put back", () => {
  const feed = [st("Malmö C", 55.609, 13.0), st("Stockholm C", 59.33, 18.05)];
  const chain = ["Malmö C", "Hässleholm C", "Stockholm C"];
  assert.deepEqual(fillForeignGaps(feed, chain, botStation).inserted, []);
});

await check("the row's direction is chosen by station order, not by its label", () => {
  const row = {
    trip_short_name_0: "300",
    origin_trip_0: "Stockholm C",
    via_0: "Lund C - Malmö C - København Syd - Hamburg Hbf",
    destination_trip_0: "Berlin Hbf",
    trip_short_name_1: "301",
    origin_trip_1: "Berlin Hbf",
    via_1: "Hamburg Hbf - København Syd - Malmö C - Lund C",
    destination_trip_1: "Stockholm C",
  };
  // The feed runs 300 Berlin → Stockholm, the reverse of the row's label.
  assert.equal(orientedChain(row, ["Berlin Hbf", "København Syd", "Malmö C", "Stockholm C"]).d, 1);
});

await check("labels the wrong way round are matched by direction, so trips and notes stay with their train", () => {
  const train = (feedRoute, from, to) => ({ lineName: feedRoute, feedRoute, stations: [{ name: from }, { name: to }] });
  const row = {
    agency_id: "ST",
    trip_short_name_0: "300",
    origin_trip_0: "Stockholm C",
    destination_trip_0: "Berlin Hbf",
    trip_short_name_1: "301",
    origin_trip_1: "Berlin Hbf",
    destination_trip_1: "Stockholm C",
  };
  const trains = {
    300: train("300", "Berlin Hbf", "Stockholm C"),
    301: train("301", "Stockholm C", "Berlin Gesundbrunnen"),
  };
  const done = alignLabelsWithRows(trains, { 77: row }, ["ST"]);
  assert.deepEqual(done.map((d) => d.feedRoutes), [["301", "300"]]);
  assert.equal(trains["300"].stations[0].name, "Stockholm C", "row label 300 now carries the southbound train");
  assert.equal(trains["300"].lineName, "300");
  assert.equal(trains["300"].feedRoute, "301", "the operator's own number is kept on the train");
  // Idempotent: once the row agrees, nothing moves.
  assert.deepEqual(alignLabelsWithRows(trains, { 77: row }, ["ST"]), []);
  // A row pointing the same way as the feed is left alone.
  const same = { 1: { agency_id: "SJ", trip_short_name_0: "1", origin_trip_0: "Stockholm C", destination_trip_0: "Malmö C", trip_short_name_1: "2", origin_trip_1: "Malmö C", destination_trip_1: "Stockholm C" } };
  const sj = { 1: train("1", "Stockholm C", "Malmö C"), 2: train("2", "Malmö C", "Stockholm C") };
  assert.deepEqual(alignLabelsWithRows(sj, same, ["SJ"]), []);
});

// ─── 5. End to end on an in-memory feed ─────────────────────────────────────

await check("buildTrafiklabTrains: allowlist by number and route_type, Back-on-Track label, row season", () => {
  const cal = (id) => ({ service_id: id, monday: "0", tuesday: "0", wednesday: "0", thursday: "0", friday: "0", saturday: "0", sunday: "0", start_date: "", end_date: "" });
  const stopsById = new Map(
    [
      ["m", "Malmö Centralstation", 55.6093, 13.0007],
      ["s", "Stockholm Centralstation", 59.3315, 18.0549],
      ["o", "Storlien järnvägsstation", 63.3163, 12.1002],
    ].map(([id, name, lat, lon]) => [id, { stop_id: id, stop_name: name, stop_lat: String(lat), stop_lon: String(lon), parent_station: "" }]),
  );
  const feed = {
    routes: [
      { route_id: "r24", agency_name: "Snälltåget", route_short_name: "24", route_type: "105" },
      { route_id: "r1s", agency_name: "SJ AB", route_short_name: "1", route_type: "100" },
    ],
    trips: [
      { route_id: "r24", trip_id: "t24", service_id: "s24" },
      { route_id: "r1s", trip_id: "t1", service_id: "s1" },
    ],
    stopTimes: [
      { trip_id: "t24", stop_id: "m", stop_sequence: "1", arrival_time: "16:35:00", departure_time: "16:35:00" },
      { trip_id: "t24", stop_id: "s", stop_sequence: "2", arrival_time: "22:30:00", departure_time: "22:55:00" },
      { trip_id: "t24", stop_id: "o", stop_sequence: "3", arrival_time: "32:45:00", departure_time: "32:45:00" },
    ],
    stopsById,
    calendar: [cal("s24"), cal("s1")],
    calendarDates: [
      ...["20260926", "20260930", "20261003"].map((date) => ({ service_id: "s24", date, exception_type: "1" })),
      ...span("2026-09-26", "2026-12-11", ALL).map((date) => ({ service_id: "s1", date, exception_type: "1" })),
    ],
  };
  const allowlist = {
    operators: { "Snälltåget": { agencyId: "ST", operator: "Snälltåget" } },
    routeTypes: ["105"],
    routes: [
      { agency: "Snälltåget", route: "24", name: "3920" },
      { agency: "SJ AB", route: "1", name: "1" },
    ],
  };
  const viewMap = {
    79: {
      agency_id: "ST",
      trip_short_name_0: "3920",
      origin_trip_0: "Malmö C",
      destination_trip_0: "Storlien",
      service_id_0: "2026/06/25-09/27: Wed, Sat",
    },
  };
  const stats = {};
  const trains = buildTrafiklabTrains({
    feed,
    allowlist,
    today: "2026-09-26",
    botStops,
    viewMap,
    agencyScope: ["SJ", "ST"],
    resolveAlias: (n) => n,
    stats,
  });
  assert.deepEqual(Object.keys(trains), ["3920"], "SJ's route_type 100 twin of train 1 is not a sleeper");
  const t = trains["3920"];
  assert.equal(t.agency_id, "ST");
  assert.deepEqual(t.stations.map((s) => s.name), ["Malmö C", "Stockholm C", "Storlien"]);
  assert.equal(t.stations[2].arrival, "08:45");
  // The horizon is this train's own last date here, so it reads yearly; the
  // season rule itself is pinned above. What matters is the label and scope.
  assert.ok(/Wed, Sat$/.test(t.frequency), t.frequency);
  assert.equal(polyline.decode(t.polyline).length, 3);
  assert.ok(stats.unmatched.some((u) => u.startsWith("SJ AB 1")), "an entry matching nothing is reported");
});

// ─── 6. Streaming reader ────────────────────────────────────────────────────

await check("streamZipCsv reads a member row by row and pre-filters on its key", async () => {
  let hasZip = true;
  try {
    execSync("zip -v", { stdio: "ignore" });
  } catch {
    hasZip = false;
  }
  if (!hasZip) {
    console.log("    (zip not installed — skipped)");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trafiklab-"));
  fs.writeFileSync(
    path.join(dir, "stop_times.txt"),
    "﻿trip_id,arrival_time,stop_id\r\na,23:17:00,1\r\nb,24:54:00,2\r\n\"a\",30:59:00,3\r\n",
  );
  execSync(`zip -q feed.zip stop_times.txt`, { cwd: dir });
  const zip = path.join(dir, "feed.zip");
  const rows = [];
  await streamZipCsv(zip, "stop_times.txt", (r) => rows.push(r), { keep: { column: "trip_id", test: (id) => id === "a" } });
  assert.deepEqual(rows.map((r) => r.arrival_time), ["23:17:00", "30:59:00"]);
  assert.equal(await streamZipCsv(zip, "shapes.txt", () => {}), 0, "a missing optional table is empty, not an error");
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("only Trafiklab's host is asked for gzip", () => {
  assert.equal(headersFor("https://opendata.samtrafiken.se/gtfs-sweden/sweden.zip?key=x")["Accept-Encoding"], "gzip");
  assert.deepEqual(headersFor("https://storage.googleapis.com/mobilitydata-datasets-prod/mdb-2939/latest.zip"), {});
});

// ─── 7. The committed artifacts ─────────────────────────────────────────────

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const readData = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

await check("the committed trains file carries every allowlisted train", () => {
  const allow = readData("data/sources/trafiklab-sleepers.json");
  const trains = readData("public/data/scraped/trafiklab-trains.json").data.trains;
  for (const r of allow.routes) {
    const t = trains[r.name ?? r.route];
    assert.ok(t, `train ${r.name ?? r.route} present`);
    assert.ok(t.stations.every((s) => Number.isFinite(s.location?.latitude)), `${t.lineName}: every stop located`);
  }
});

await check("the published payload: Swedish rows stamped, 93/94 on the map, no row pointing at a missing stop", () => {
  const pub = readData("public/data/published/initial-data.json").data;
  const stops = new Set(pub.stops.map((s) => String(s.stop_name).toLowerCase()));
  const rows = Object.entries(pub.viewMap).filter(([, r]) => (r.official_sources ?? []).includes("trafiklab"));
  assert.ok(rows.length >= 5, `${rows.length} stamped rows`);
  const synthetic = Object.keys(pub.viewMap).filter((k) => k.startsWith("trafiklab_"));
  // No enriched direction runs the opposite way from its trip. Endpoints may
  // move (SJ 91 starts in Umeå, not Luleå), but the panel pairs a trip with its
  // row direction by direction_id, so a reversed row would put one train's
  // times under the other's card — the row 77 fault alignLabelsWithRows fixes.
  const trips = Object.values(pub.trips);
  for (const [key, row] of rows) {
    for (const d of [0, 1]) {
      const trip = trips.find((t) => String(t.route_id) === key && String(t.trip_short_name) === String(row[`trip_short_name_${d}`]));
      if (!trip?.trip_origin) continue;
      const city = (n) => String(n).split(" ")[0].toLowerCase();
      const reversed =
        city(row[`origin_trip_${d}`]) === city(trip.trip_headsign) &&
        city(row[`destination_trip_${d}`]) === city(trip.trip_origin);
      assert.ok(!reversed, `row ${key} dir ${d} runs the opposite way from trip ${trip.trip_short_name}`);
    }
  }
  assert.ok(synthetic.length >= 1, "Luleå–Stockholm (93/94) is a route of its own");
  for (const [key, row] of [...rows, ...synthetic.map((k) => [k, pub.viewMap[k]])]) {
    for (const d of [0, 1]) {
      const names = [row[`origin_trip_${d}`], ...String(row[`via_${d}`] ?? "").split(" - "), row[`destination_trip_${d}`]].filter(Boolean);
      for (const n of names) assert.ok(stops.has(n.toLowerCase()), `row ${key}: "${n}" has a stop record`);
    }
  }
});

// ─── 8. The detail panel reads the source's own timetable ──────────────────
// A synthetic row has no Back-on-Track trips, so the panel showed "No Back on
// Track trip data" for Stockholm–Luleå; a corroborated row listed its via names
// with a time only at each end. Both now read the trains file named by the
// row's timetable_source.

await check("sourceFeedSchedule times every stop from the source's trains file", () => {
  const trains = {
    93: {
      frequency: "2026: Daily",
      stations: [
        { name: "Luleå C", code: "144", departure: "21:10" },
        { name: "Umeå C", arrival: "01:41", departure: "01:44" },
        { name: "Stockholm C", arrival: "2026-09-27T10:13:00" },
      ],
    },
  };
  const s = sourceFeedSchedule(trains, { trip_short_name: "93" });
  assert.deepEqual(s.stops.map((x) => [x.name, x.arrival, x.departure]), [
    ["Luleå C", null, "21:10"],
    ["Umeå C", "01:41", "01:44"],
    ["Stockholm C", "10:13", null],
  ]);
  assert.equal(s.days, "2026: Daily");
  assert.equal(sourceFeedSchedule(trains, { trip_short_name: "94" }), null, "a train the file lacks is no schedule");
  assert.equal(sourceFeedSchedule(null, { trip_short_name: "93" }), null);
  assert.equal(sourceFeedIdForRoute({ timetable_source: "trafiklab" }), "trafiklab");
  assert.equal(sourceFeedIdForRoute({}), null);
});

await check("every Swedish row names Trafiklab as its timetable, and no bundle source is named", () => {
  const pub = readData("public/data/published/initial-data.json").data;
  const registry = readData("data/sources/registry.json");
  const withTrains = new Set(registry.filter((e) => e.output && e.enrich?.strategy === "trainsByNumber").map((e) => e.id));
  for (const [key, row] of Object.entries(pub.viewMap)) {
    if ((row.official_sources ?? []).includes("trafiklab") || key.startsWith("trafiklab_")) {
      assert.equal(row.timetable_source, "trafiklab", `row ${key}`);
    }
    if (row.timetable_source && !key.includes("_")) {
      assert.ok(withTrains.has(row.timetable_source), `row ${key} names ${row.timetable_source}, which has no trains file`);
    }
  }
});

await check("the panel reads it below every per-operator feed and above the bare via list", () => {
  const panel = fs.readFileSync(path.join(root, "src/components/TrainDetailPanel/TrainDetailPanel.js"), "utf8");
  assert.match(panel, /esSchedule \|\|\s*sourceSchedule \|\|\s*viaSchedule;/);
  // …and admits a synthetic row it cannot place in a hardcoded feed.
  assert.match(panel, /sourceFeedIdForRoute\(routes\[t\.route_id\]\)/);
});

console.log(`\n[verify-trafiklab] ${checks} checks passed`);
