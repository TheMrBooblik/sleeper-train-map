// tests/verify-trenitalia-gtfs.mjs
// Trenitalia Intercity Notte from the national GTFS
// (scripts/adapters/trenitalia-gtfs.mjs). The feed is hand-built here in the
// real one's shape (mdb-3569, version 2026-10-15): one calendar.txt row per
// works variant, past-midnight times as hours ≥ 24, and the cases from that
// feed each rule exists for — a works number standing in for a timetable
// train (95063 for ICN 1959, which only exists from the December timetable),
// a short-lived timetable number doing the same (1930 for 1958), two trains on
// one pair that both run (755 and 765 Milano → Lecce), and a number with two
// through-car portions (1955 to Catania and to Palermo, the longer one). The committed trains
// file is checked last.
//
// Run: node tests/verify-trenitalia-gtfs.mjs

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { buildTrenitaliaTrains, orderInPairs, romeInstant } from "../scripts/adapters/trenitalia-gtfs.mjs";
import { rowTrainKey, stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";
import { getStationTimesForTrain } from "../src/lib/seo/stationTimes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// ─── A small feed ───────────────────────────────────────────────────────────

const STOPS = {
  "08409": ["ROMA TERMINI", 41.9005, 12.502],
  "09218": ["NAPOLI CENTRALE", 40.8528, 14.2727],
  "11781": ["REGGIO DI CALABRIA CENTRALE", 38.1021, 15.6358],
  "11883": ["LAMEZIA TERME CENTRALE", 38.9065, 16.2385],
  "12000": ["MESSINA CENTRALE", 38.1857, 15.5543],
  "12345": ["CATANIA CENTRALE", 37.5067, 15.1004],
  "07000": ["PALERMO CENTRALE", 38.1095, 13.367],
  "12019": ["CEFALU'", 38.0386, 14.0232],
  "01700": ["MILANO CENTRALE", 45.4863, 9.2045],
  "05043": ["BOLOGNA C.LE/AV", 44.5057, 11.343],
  "11145": ["LECCE", 40.3473, 18.1645],
};

function makeFeed() {
  const routes = [{ route_id: "r", route_short_name: "ICN" }];
  const trips = [];
  const stopTimes = [];
  const calendar = [];
  const shapes = new Map();
  let n = 0;
  // days "1111111" Mon..Sun
  const add = (number, stops, { start, end, days = "1111111", shape = true }) => {
    n += 1;
    const trip_id = `t${n}`;
    const service_id = `s${n}`;
    const shape_id = shape ? `shp${n}` : "";
    trips.push({ route_id: "r", service_id, trip_id, trip_short_name: String(number), shape_id });
    stops.forEach(([id, arr, dep], i) => {
      stopTimes.push({ trip_id, stop_id: id, stop_sequence: String(i + 1), arrival_time: arr, departure_time: dep });
    });
    const [mo, tu, we, th, fr, sa, su] = days.split("");
    calendar.push({
      service_id,
      monday: mo, tuesday: tu, wednesday: we, thursday: th, friday: fr, saturday: sa, sunday: su,
      start_date: start,
      end_date: end,
    });
    if (shape) {
      // A track that wiggles between the stops: more points than stations.
      const pts = [];
      stops.forEach(([id], i) => {
        const [, lat, lon] = STOPS[id];
        pts.push([pts.length + 1, lat, lon]);
        const next = stops[i + 1];
        if (next) {
          const [, lat2, lon2] = STOPS[next[0]];
          pts.push([pts.length + 1, (lat + lat2) / 2 + 0.05, (lon + lon2) / 2 - 0.05]);
        }
      });
      shapes.set(shape_id, pts);
    }
  };

  // ICN 1959 Roma → Palermo exists from the December timetable only; before
  // that the same train runs as works number 95063, departing at the same time.
  const lamezia = (dep) => [
    ["08409", dep, dep],
    ["11883", "30:02:00", "30:03:00"],
    ["12000", "33:38:00", "33:45:00"],
    ["07000", "37:12:00", "37:12:00"],
  ];
  add(1959, lamezia("23:25:00"), { start: "20261213", end: "20270110" });
  add(95063, lamezia("23:25:00"), { start: "20261017", end: "20261212" });

  // ICN 1955 Roma → Catania and its Palermo portion, split at Messina.
  add(1955, [
    ["08409", "20:16:00", "20:16:00"],
    ["09218", "22:33:00", "22:37:00"],
    ["12000", "29:50:00", "29:53:00"],
    ["12345", "31:46:00", "31:46:00"],
  ], { start: "20261017", end: "20270110" });
  add(1955, [
    ["08409", "20:16:00", "20:16:00"],
    ["09218", "22:33:00", "22:37:00"],
    ["12000", "29:50:00", "29:55:00"],
    ["12019", "32:26:00", "32:27:00"],
    ["07000", "33:13:00", "33:13:00"],
  ], { start: "20261017", end: "20270110" });

  // ICN 1958 Palermo → Roma, except on weeknights 19 Oct – 6 Nov, when the
  // same train runs as ICN 1930 ten minutes earlier.
  const palermoRoma = (dep) => [
    ["07000", dep, dep],
    ["12000", "24:35:00", "24:40:00"],
    ["09218", "31:55:00", "31:59:00"],
    ["08409", "34:25:00", "34:25:00"],
  ];
  add(1958, palermoRoma("20:35:00"), { start: "20261017", end: "20261018" });
  add(1958, palermoRoma("20:35:00"), { start: "20261024", end: "20261025", days: "0000011" });
  add(1958, palermoRoma("20:35:00"), { start: "20261031", end: "20261101", days: "0000011" });
  add(1958, palermoRoma("20:35:00"), { start: "20261107", end: "20270110" });
  add(1930, palermoRoma("20:25:00"), { start: "20261019", end: "20261106", days: "1111100" });
  // ICN 1956 Palermo → Roma via Lamezia (the return of 1959), and its works number.
  const lameziaBack = (dep) => [
    ["07000", dep, dep],
    ["12000", "22:10:00", "22:20:00"],
    ["11883", "25:08:00", "25:09:00"],
    ["08409", "31:24:00", "31:24:00"],
  ];
  add(1956, lameziaBack("18:48:00"), { start: "20261213", end: "20270110" });
  add(95074, lameziaBack("18:48:00"), { start: "20261017", end: "20261212" });

  // ICN 1960 Catania → Roma.
  add(1960, [
    ["12345", "22:58:00", "22:58:00"],
    ["12000", "24:35:00", "24:40:00"],
    ["09218", "31:55:00", "31:59:00"],
    ["08409", "34:25:00", "34:25:00"],
  ], { start: "20261017", end: "20270110" });

  // Two trains Milano → Lecce that both run every night: never folded.
  const milanoLecce = (dep) => [
    ["01700", dep, dep],
    ["05043", "23:05:00", "23:10:00"],
    ["11145", "33:30:00", "33:30:00"],
  ];
  add(755, milanoLecce("21:49:00"), { start: "20261017", end: "20270110" });
  add(765, milanoLecce("21:09:00"), { start: "20261017", end: "20270110" });
  // A single diverted night under its own number: not a train.
  add(89645, milanoLecce("19:45:00"), { start: "20261024", end: "20261024" });

  const stopsById = new Map(
    Object.entries(STOPS).map(([id, [name, lat, lon]]) => [
      id,
      { stop_id: id, stop_name: name, stop_lat: String(lat), stop_lon: String(lon) },
    ]),
  );
  return { routes, trips, stopTimes, stopsById, calendar, calendarDates: [], shapes, feedInfo: null };
}

// ─── Building trains ────────────────────────────────────────────────────────

console.log("trains from the feed");
const stats = {};
const trains = buildTrenitaliaTrains({
  feed: makeFeed(),
  today: "2026-10-21",
  config: { stationNames: { "05043": "Bologna Centrale" } },
  stats,
});
const keys = Object.keys(trains);

check(
  "a works number running before the timetable number exists is shown under the timetable number",
  trains["ICN 1959"] && !trains["ICN 95063"] && trains["ICN 1959"].operatedAs?.join() === "95063",
  keys.join(", "),
);
check(
  "…with the stand-in's stops and times, and runs in the current period",
  trains["ICN 1959"]?.stations.length === 4 && trains["ICN 1959"].runsInWindow > 40,
);
check(
  "a short-lived timetable number on the nights the main one does not run is folded too (1930 → 1958)",
  trains["ICN 1958"] && !trains["ICN 1930"] && trains["ICN 1958"].operatedAs?.join() === "1930",
  keys.join(", "),
);
check(
  "the folded train's days are every night either number runs",
  trains["ICN 1958"]?.frequency === "2026: Daily",
  trains["ICN 1958"]?.frequency,
);
check(
  "two trains on one pair that both run every night stay two trains",
  trains["ICN 755"] && trains["ICN 765"] && !trains["ICN 755"].operatedAs && !trains["ICN 765"].operatedAs,
);
check(
  "a one-night run under its own number is left out, not made a train",
  !trains["ICN 89645"] && stats.oneOffs.some((o) => o.startsWith("89645")),
  stats.oneOffs.join(", "),
);
check(
  "a number with two portions is two trains; the other portion is keyed by its city",
  trains["ICN 1955"]?.stations.at(-1).name === "Catania Centrale" &&
    trains["ICN 1955 (Palermo)"]?.stations.at(-1).name === "Palermo Centrale",
  keys.join(", "),
);
check(
  "…and both are shown as the number the operator sells them under",
  trains["ICN 1955"]?.lineName === "ICN 1955" && trains["ICN 1955 (Palermo)"]?.lineName === "ICN 1955",
  `${trains["ICN 1955"]?.lineName} / ${trains["ICN 1955 (Palermo)"]?.lineName}`,
);
check(
  "station codes are Viaggiatreno's (S + stop_id), which lefrecce and the schedule link address",
  trains["ICN 1955"]?.stations[0].code === "S08409",
);
check(
  "a pinned station name wins over the feed's spelling",
  trains["ICN 755"]?.stations[1].name === "Bologna Centrale",
  trains["ICN 755"]?.stations[1].name,
);
check(
  "other names are the feed's, title-cased as Viaggiatreno's were",
  trains["ICN 1960"]?.stations[0].name === "Catania Centrale",
);
check(
  "the line is the feed's shape, not the station chain",
  polyline.decode(trains["ICN 1955"].polyline).length > trains["ICN 1955"].stations.length,
);
check(
  "times are instants on the Italian clock, origin without an arrival, terminus without a departure",
  trains["ICN 1960"].stations[0].arrival === null &&
    trains["ICN 1960"].stations.at(-1).departure === null &&
    // 22:58 on 21 October, still summer time.
    trains["ICN 1960"].stations[0].departure === "2026-10-21T20:58:00.000Z",
  trains["ICN 1960"].stations[0].departure,
);

console.log("pair order");
const order = Object.keys(trains);
const after = (k) => order[order.indexOf(k) + 1];
check("1955 (Catania) is followed by its return 1960", after("ICN 1955") === "ICN 1960", order.join(", "));
check(
  "Roma ↔ Palermo has two trains each way, paired by the stops they share",
  after("ICN 1955 (Palermo)") === "ICN 1958" &&
    (after("ICN 1956") === "ICN 1959" || after("ICN 1959") === "ICN 1956"),
  order.join(", "),
);
{
  const s = (codes) => ({ stations: codes.map((c) => ({ code: c })) });
  const ordered = Object.keys(
    orderInPairs({
      "ICN 1": s(["A", "X", "B"]),
      "ICN 2": s(["B", "Y", "A"]),
      "ICN 3": s(["B", "X", "A"]),
    }),
  );
  check("orderInPairs picks the reverse train sharing more stops", ordered.join() === "ICN 1,ICN 3,ICN 2", ordered.join());
}

console.log("Italian clock");
check("summer time: 20:25 on 21 Oct is 18:25Z", romeInstant("20261021", "20:25:00") === "2026-10-21T18:25:00.000Z");
check("winter time: 20:25 on 2 Nov is 19:25Z", romeInstant("20261102", "20:25:00") === "2026-11-02T19:25:00.000Z");
check(
  "an hour ≥ 24 is the next morning, on that morning's clock (25 Oct, the change night)",
  romeInstant("20261024", "31:24:00") === "2026-10-25T06:24:00.000Z",
  romeInstant("20261024", "31:24:00"),
);

// ─── One number, two rows: shown alike, looked up apart ────────────────────

console.log("one number on two rows");
{
  // The two portions of ICN 1963 priced differently: a row labelled by the
  // shared number must still read its own train's fare, not the other's.
  const operatorTrains = {
    italian: {
      "ICN 1963": { lineName: "ICN 1963", stations: [{ code: "S01700" }], fare: { fromPrice: 54.9, currency: "EUR" } },
      "ICN 1963 (Palermo)": { lineName: "ICN 1963", stations: [{ code: "S01700" }], fare: { fromPrice: 65.9, currency: "EUR" } },
    },
  };
  const viewMap = {
    a: { route_id: "a", timetable_source: "italian", agency_id: "FS", trip_short_name_0: "ICN 1963" },
    b: {
      route_id: "b",
      timetable_source: "italian",
      agency_id: "FS",
      trip_short_name_0: "ICN 1963",
      train_key_0: "ICN 1963 (Palermo)",
    },
  };
  stampOfficialFares(viewMap, {}, operatorTrains, [{ id: "italian", enabled: true, official: true }]);
  check(
    "rowTrainKey reads train_key first, the label otherwise",
    rowTrainKey(viewMap.b, 0) === "ICN 1963 (Palermo)" && rowTrainKey(viewMap.a, 0) === "ICN 1963",
  );
  check(
    "each row takes its own portion's fare, and quotes it under the shown number",
    viewMap.a.fare_0?.fromPrice === 54.9 &&
      viewMap.b.fare_0?.fromPrice === 65.9 &&
      viewMap.b.pricing?.trainName === "ICN 1963",
    `${viewMap.a.fare_0?.fromPrice} / ${viewMap.b.fare_0?.fromPrice} / ${viewMap.b.pricing?.trainName}`,
  );
}
{
  const published = JSON.parse(
    fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"),
  );
  const rows = Object.values(published.data?.viewMap ?? published.viewMap ?? {}).filter((r) =>
    String(r.route_id).startsWith("icn_"),
  );
  const shown = rows.flatMap((r) => [r.trip_short_name_0, r.trip_short_name_1]).filter(Boolean);
  check(
    "no published Intercity Notte row shows a portion's city beside its number",
    shown.every((n) => /^ICN \d+$/.test(n)),
    shown.filter((n) => !/^ICN \d+$/.test(n)).join(", "),
  );
  const palermo = rows.find((r) => r.train_key_0 === "ICN 1963 (Palermo)" || r.train_key_1 === "ICN 1963 (Palermo)");
  const trainsFile = JSON.parse(
    fs.readFileSync(path.join(ROOT, "public/data/scraped/italian-trains.json"), "utf8"),
  ).data.trains;
  const dir = palermo?.train_key_0 === "ICN 1963 (Palermo)" ? 0 : 1;
  check(
    "the Milano–Palermo row reads the Palermo portion's fare, not the Catania one's",
    palermo &&
      palermo[`trip_short_name_${dir}`] === "ICN 1963" &&
      palermo[`fare_${dir}`]?.fromPrice === trainsFile["ICN 1963 (Palermo)"]?.fare?.fromPrice,
    palermo ? `${palermo[`fare_${dir}`]?.fromPrice} vs ${trainsFile["ICN 1963 (Palermo)"]?.fare?.fromPrice}` : "no row",
  );
  const stops = getStationTimesForTrain("ICN 1963", {
    origin: "Milano Centrale",
    destination: "Palermo Centrale",
  });
  check(
    "the connection page finds the Palermo portion's timetable under the shown number",
    stops?.at(-1)?.name === "Palermo Centrale" && stops.length > 20,
    `${stops?.length} stops`,
  );
}

// ─── The committed trains file ──────────────────────────────────────────────

console.log("committed italian-trains.json");
const file = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/scraped/italian-trains.json"), "utf8"));
const committed = file.data?.trains ?? {};
const list = Object.values(committed);
check("at least 24 Intercity Notte trains", list.length >= 24, `${list.length}`);
check(
  "every train has its days, its codes and a drawn line longer than its station chain",
  list.every(
    (t) =>
      t.frequency &&
      t.stations.every((s) => /^S\d{5}$/.test(s.code)) &&
      polyline.decode(t.polyline).length > t.stations.length,
  ),
  list.filter((t) => !t.frequency || polyline.decode(t.polyline).length <= t.stations.length).map((t) => t.lineName).join(", "),
);
const ends = (t) => `${t.stations[0].name}>${t.stations.at(-1).name}`;
const byEnds = new Set(list.map(ends));
check(
  "every train has a return train in the file (no direction lost on a night it does not run)",
  list.every((t) => byEnds.has(`${t.stations.at(-1).name}>${t.stations[0].name}`)),
  list.filter((t) => !byEnds.has(`${t.stations.at(-1).name}>${t.stations[0].name}`)).map((t) => t.lineName).join(", "),
);

if (failures) {
  console.log(`\nverify-trenitalia-gtfs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nverify-trenitalia-gtfs: all checks passed");
