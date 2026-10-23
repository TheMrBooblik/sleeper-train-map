// tests/verify-regiojet.mjs
// RegioJet (scripts/lib/regiojet.mjs, scripts/lib/rj-fares.mjs,
// scripts/adapters/regiojet-gtfs.mjs).
//
// tests/fixtures/regiojet/{international,interstate}/*.txt are RegioJet's
// real GTFS as published on ybus.sa.cz on 2026-10-23, cut down to the trips
// that matter: every night train (RJ 1020–1023, both portions of 1020/1021),
// two day trains on the same route (RJ 1003, RJ 1011 — Praha–Košice by day)
// and the domestic file's three latest trains (R 1132, R 1133, R 1314), which
// run late but end before midnight. Their stops, calendars, exceptions and
// shapes are whole.
//
// REAL_SEAT_CLASSES is GET /consts/seatClasses as the "Probe RegioJet source"
// workflow printed it on 2026-10-23 (key and English title), and the
// connection answer below carries the classes and prices that run read for
// RJ 1021 on 30 October (C0 €23.90, TRAIN_COUCHETTE_RELAX €65.90,
// TRAIN_COUCHETTE_BUSINESS_4 €176). The search answers are synthetic, in the
// shape the probe printed.
//
// Run: node tests/verify-regiojet.mjs

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  buildRegiojetTrains,
  isRealShape,
  makeStationNamer,
  mergeFeeds,
  nameCandidates,
  normalizeFeedStationName,
  nightRuns,
  trainNumberOf,
} from "../scripts/lib/regiojet.mjs";
import {
  berthClasses,
  buildRouteUrl,
  buildSearchUrl,
  classifySeatClass,
  fillRjFareCalendars,
  findTrainRoute,
  pragueClock,
} from "../scripts/lib/rj-fares.mjs";
import { readFeedDir, siblingLines } from "../scripts/adapters/regiojet-gtfs.mjs";
import { sourceFeedSchedule } from "../src/lib/sourceFeedSchedule.mjs";
import { fareClassLabel } from "../src/lib/fareClasses.mjs";
import STATION_ALIASES from "../data/overrides/station-aliases.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "tests/fixtures/regiojet");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const config = read("data/sources/regiojet-sleepers.json");
const registry = read("data/sources/registry.json");
const entry = registry.find((e) => e.id === "regiojet");
const booking = read("data/overrides/operator-booking.json").RJ;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("registry");
check("one enabled RegioJet source, the old disabled drop gone", !!entry?.enabled && !registry.some((e) => e.id === "regiojet-gtfs"));
check("both feeds are read", eq(entry.params.feeds.map((f) => f.url).sort(), ["https://ybus.sa.cz/gtfe/google_transit.zip", "https://ybus.sa.cz/gtfe/international/google_transit.zip"]));
check("the documented endpoint is one of them", entry.params.feeds.some((f) => f.url === entry.endpoint));
check(
  "Back-on-Track's rows keep their hand-traced lines (no setPolyline)",
  !entry.enrich.setPolyline && entry.enrich.updateVia && entry.enrich.setTimes && entry.enrich.updateServiceDays && entry.enrich.stamp,
);
check("enrichment and synthetic coverage scoped to RegioJet", eq(entry.enrich.agencyIds, ["RJ"]) && eq(entry.synthetic.botMatchAgencies, ["RJ"]));

console.log("names");
check("train number", trainNumberOf("RJ 1021") === "1021" && trainNumberOf("RJ 1005/1028") === "1005" && trainNumberOf("R 8") === null);
check(
  "feed spellings normalised",
  normalizeFeedStationName("Košice, žst.") === "Košice" &&
    normalizeFeedStationName("Margecany, žel. st.") === "Margecany" &&
    normalizeFeedStationName("Ostrava, hl.n.") === "Ostrava hl.n." &&
    normalizeFeedStationName("Kysak (u města Prešov), žst.") === "Kysak" &&
    normalizeFeedStationName("Poprad, Tatry") === "Poprad Tatry",
);
check("a district reads with a hyphen too", nameCandidates("Ostrava, Svinov").includes("Ostrava-Svinov"));

console.log("the feeds (real)");
const feed = mergeFeeds([
  { id: "international", tables: readFeedDir(path.join(FIX, "international")) },
  { id: "interstate", tables: readFeedDir(path.join(FIX, "interstate")) },
]);
check("ids are prefixed by feed", [...feed.stopsById.keys()].every((k) => /^(international|interstate):/.test(k)) && feed.trips.every((t) => t.trip_id.includes(":")));
check(
  "the feed's shapes are the station chain, not track",
  feed.trips.every((t) => !isRealShape(feed.shapes.get(t.shape_id), feed.stopTimesByTrip.get(t.trip_id)?.length ?? 0)),
  feed.trips.map((t) => `${t.trip_short_name} ${feed.shapes.get(t.shape_id)?.length}/${feed.stopTimesByTrip.get(t.trip_id)?.length}`).join(", "),
);
const botStops = Object.values(read("public/data/scraped/backontrack-stops.json").data);
const nameStop = makeStationNamer({
  stops: botStops,
  resolveAlias: (n) => STATION_ALIASES[String(n).toLowerCase().trim()] ?? n,
  stationNames: config.stationNames,
});
const { byNumber } = nightRuns(feed, config, nameStop);
check("only the night trains: RJ 1020–1023", eq([...byNumber.keys()].sort(), ["1020", "1021", "1022", "1023"]), JSON.stringify([...byNumber.keys()]));
check("RJ 1020 is filed twice (Čop through cars and the Košice train)", byNumber.get("1020").length === 2);

const donors = siblingLines(ROOT, entry.params.siblingTracks);
check("sibling lines read (static corridors, PKP GTFS, trains files)", donors.length > 20, String(donors.length));
const trains = buildRegiojetTrains({ config, feed, nameStop, donors, today: "2026-10-23" });
check("four trains, in pairs", eq(Object.keys(trains), ["1020", "1021", "1022", "1023"]));
const t20 = trains["1020"];
const t21 = trains["1021"];
const t22 = trains["1022"];
const t23 = trains["1023"];
check("RJ 1020 is the Čop run: Košice's portion plus the leg to Čop", t20.stations[0].name === "Chop" && t20.stations.length === 18 && t20.stations[1].name === "Košice");
check("RJ 1021 Praha 21:46 → Chop 10:38 the next day", t21.stations[0].departure === "21:46" && t21.stations.at(-1).arrival === "10:38" && t21.stations.at(-1).arrivalDay === 1);
check("duration from the feed's own clocks (21:46 → 10:38 +1)", t21.durationMinutes === 12 * 60 + 52, String(t21.durationMinutes));
check("daily through the period the feed covers", [t20, t21, t22, t23].every((t) => t.frequency === "2026: Daily"), [t20, t21, t22, t23].map((t) => t.frequency).join(" / "));
check("a validity window", t20.timetable.validUntil === "2026-12-12" && t22.timetable.validUntil === "2026-12-11");
check("lineName is the operator's, key is Back-on-Track's bare number", t20.lineName === "RJ 1020" && t20.trainNo === "1020");
const names = (t) => t.stations.map((s) => s.name);
check(
  "stations take the dataset's spelling where it is the same place",
  eq(names(t23), ["Praha hl.n.", "Pardubice hl.n.", "Olomouc hl.n.", "Ostrava-Svinov", "Ostrava hl.n.", "Kraków Gł.", "Rzeszow Gł.", "Przemyśl Gł."]),
  names(t23).join(" | "),
);
check("Slovak stations too", ["Kysak", "Margecany", "Poprad Tatry", "Spišská Nová Ves", "Liptovský Mikuláš", "Žilina", "Čadca", "Havířov"].every((n) => names(t21).includes(n)));
check(
  "RegioJet sells no domestic journey: 1023 only sets down in Poland",
  t23.stations.slice(1, 5).every((s) => s.pickup && !s.dropoff) && t23.stations.slice(5).every((s) => s.dropoff),
);
check("…and 1022 only takes on in Poland", t22.stations.slice(0, 3).every((s) => s.pickup) && t22.stations.slice(3, 7).every((s) => !s.pickup && s.dropoff));
check(
  "booking ids: the station's and the city's",
  t21.stations[0].code === "372825000" && t21.stations[0].cityId === "10202003" && t21.stations.at(-1).cityId === "7122881001",
);
check(
  "the Book link knows every station's city id, and agrees with the feed",
  Object.values(trains).every((t) => t.stations.every((s) => booking.stationNames[s.name] === s.cityId)),
  Object.values(trains)
    .flatMap((t) => t.stations)
    .filter((s) => booking.stationNames[s.name] !== s.cityId)
    .map((s) => `${s.name}=${s.cityId}`)
    .join(", "),
);
check("the Book link takes a night", booking.urlDateSuffix === "&departureDate={date}" && booking.dateFormat === "yyyy-MM-dd");
const stopsOnLine = (t) => {
  const path = polyline.decode(t.polyline);
  return t.stations.every((s) => path.some(([a, b]) => Math.abs(a - s.location.latitude) < 1e-4 && Math.abs(b - s.location.longitude) < 1e-4));
};
check("every station is a vertex of its line", Object.values(trains).every(stopsOnLine));
check("most of the line is borrowed track", t21.geometry.siblings >= 12 && t23.geometry.siblings >= 5, JSON.stringify([t21.geometry, t23.geometry]));
check("no train left unbuilt without a feed: rebuilt from last night", eq(Object.keys(buildRegiojetTrains({ config, feed: null, previous: trains, today: "2026-10-24" })), Object.keys(trains)));
check("…but not a month later", Object.keys(buildRegiojetTrains({ config, feed: null, previous: trains, today: "2026-12-01" })).length === 0);
check("a train whose runs are all past is left out", Object.keys(buildRegiojetTrains({ config, feed, nameStop, today: "2026-12-20" })).length === 0);

console.log("the panel reads a train by its key");
check("by the row's bare number", sourceFeedSchedule(trains, { trip_short_name: "1021" })?.stops.length === 18);
check("a synthetic row's label with its key", sourceFeedSchedule(trains, { trip_short_name: "RJ 1021", train_key: "1021" })?.stops.length === 18);

console.log("fare reader");
const cls = (key, title = "") => classifySeatClass({ key, title });
check("couchettes by compartment", eq(cls("X", "Couchette 6 beds"), { kind: "couchette", classKey: "couchette6" }) && cls("Y", "Lehátko 4 lůžka").classKey === "couchette4");
check("sleepers by cabin", cls("Z", "Sleeper 2-bed compartment").classKey === "sleeperDouble" && cls("B", "Lůžkový vůz").classKey === "sleeperBed");
check("ladies-only left out", cls("L", "Ladies couchette").kind === "excluded" && cls("D", "Dámské lehátko").kind === "excluded");
check("seats are seats", cls("TRAIN_LOW_COST", "Low cost").kind === "seat" && cls("R", "Relax").kind === "seat");
const REAL_SEAT_CLASSES = [
  ["TRAIN_LOW_COST", "Low cost (2nd cl.)", "seat"],
  ["C0", "Standard (2nd cl.)", "seat"],
  ["TRAIN_STANDARD_PL", "Standard (2nd cl.)", "seat"],
  ["TRAIN_STANDARD_PLUS", "Standard PLUS", "seat"],
  ["C1", "Relax (2nd cl.)", "seat"],
  ["C2", "Business (1st cl.)", "seat"],
  ["TRAIN_1ST_CLASS", "Business (1st cl.)", "seat"],
  ["TRAIN_2ND_CLASS", "Low cost (2nd cl.) ", "seat"],
  ["TRAIN_COUCHETTE_BUSINESS_4", "Private compartment", "privateCouchette"],
  ["TRAIN_COUCHETTE_STANDARD", "Couchette", "couchette"],
  ["TRAIN_COUCHETTE_RELAX", "Berth", "couchette"],
  ["TRAIN_COUCHETTE_RELAX_FOR_WOMEN", "Berth - only women", "excluded"],
  ["TRAIN_COUCHETTE_BUSINESS", "Private compartment", "privateCouchette"],
  ["BUS_STANDARD", "Standard (bus)", "seat"],
  ["BUS_RELAX", "Relax (bus)", "seat"],
  ["TRAIN_R23_LOW_COST", "Low cost (2nd cl.) ", "seat"],
  ["TRAIN_R23_BUSINESS", "Business (1st cl.)", "seat"],
  ["TRAIN_R8_STANDARD", "Standard (2nd cl.)", "seat"],
  ["TRAIN_COUCHETTE_RELAX_3", "Sleeping for men and women", "sleeperTriple"],
  ["TRAIN_COUCHETTE_RELAX_3_WOMEN", "Sleeping for women", "excluded"],
  ["NO", "- no seat class -", "seat"],
];
const wrong = REAL_SEAT_CLASSES.filter(([key, title, want]) => {
  const got = classifySeatClass({ key, title });
  return (got.classKey ?? got.kind) !== want;
});
check(
  "RegioJet's real seat classes, each read as what it sells",
  !wrong.length,
  wrong.map(([k, t, w]) => `${k} "${t}" → ${JSON.stringify(classifySeatClass({ key: k, title: t }))}, want ${w}`).join("; "),
);
check(
  "a sleeping car 'for men and women' is mixed, not women-only (every RegioJet key says COUCHETTE)",
  classifySeatClass({ key: "TRAIN_COUCHETTE_RELAX_3", title: "Sleeping for men and women" }).classKey === "sleeperTriple",
);
check("every class key has a label", ["couchette", "couchette6", "couchette4", "privateCouchette", "sleeperTriple", "sleeperDouble", "sleeperBed"].every((k) => fareClassLabel(k)));
const real1021 = berthClasses(
  {
    priceClasses: [
      { seatClassKey: "C0", price: 23.9, freeSeatsCount: 30, bookable: true },
      { seatClassKey: "TRAIN_COUCHETTE_RELAX", price: 65.9, freeSeatsCount: 8, bookable: true },
      { seatClassKey: "TRAIN_COUCHETTE_RELAX_FOR_WOMEN", price: 65.9, freeSeatsCount: 4, bookable: true },
      { seatClassKey: "TRAIN_COUCHETTE_BUSINESS_4", price: 176, freeSeatsCount: 2, bookable: true },
    ],
  },
  new Map(REAL_SEAT_CLASSES.map(([key, title]) => [key, { title }])),
);
check(
  "RJ 1021 on 30 Oct read as the probe read it",
  eq(real1021.classes, { couchette: 65.9, privateCouchette: 176 }) && real1021.seat === 23.9,
  JSON.stringify(real1021),
);
const routes = {
  routes: [
    { id: "a", departureTime: "2026-10-30T21:46:00.000+01:00", arrivalTime: "2026-10-31T11:38:00.000+02:00", transfersCount: 0, vehicleTypes: ["TRAIN"] },
    { id: "b", departureTime: "2026-10-30T14:25:00.000+01:00", transfersCount: 0, vehicleTypes: ["TRAIN"] },
    { id: "c", departureTime: "2026-10-30T21:45:00.000+01:00", transfersCount: 1, vehicleTypes: ["TRAIN", "BUS"] },
  ],
};
check("our train: direct, at the feed's minute", findTrainRoute(routes, { date: "2026-10-30", departure: "21:46" }).route?.id === "a");
check("a connection with a change is not ours", findTrainRoute({ routes: [routes.routes[2]] }, { date: "2026-10-30", departure: "21:46" }).route === null);
check(
  "Čop's departure matched on Kyiv's clock or Prague's",
  findTrainRoute({ routes: [{ id: "k", departureTime: "2026-10-30T18:35:00.000+02:00" }] }, { date: "2026-10-30", departure: "17:35" }).route?.id === "k" &&
    findTrainRoute({ routes: [{ id: "p", departureTime: "2026-10-30T17:35:00.000+01:00" }] }, { date: "2026-10-30", departure: "17:35" }).route?.id === "p" &&
    pragueClock("2026-10-30T18:35:00.000+02:00").time === "17:35",
);
check("two candidates are none", findTrainRoute({ routes: [routes.routes[0], { ...routes.routes[0], id: "a2" }] }, { date: "2026-10-30", departure: "21:46" }).ambiguous);
let shapeErr = null;
try {
  findTrainRoute({ items: [] }, { date: "2026-10-30", departure: "21:46" });
} catch (err) {
  shapeErr = err;
}
check("an answer without routes is an error, never 'no train'", shapeErr?.shape === true);
const seatInfo = new Map([
  ["C6", { title: "Couchette 6-berth" }],
  ["C4", { title: "Couchette 4-berth" }],
  ["CL", { title: "Ladies couchette 6-berth" }],
  ["S2", { title: "Sleeper 2-bed compartment" }],
  ["LC", { title: "Low cost" }],
]);
const detail = {
  priceClasses: [
    { seatClassKey: "LC", price: 19.9, freeSeatsCount: 40 },
    { seatClassKey: "C6", price: 34.9, freeSeatsCount: 12 },
    { seatClassKey: "C6", price: 39.9, freeSeatsCount: 3 },
    { seatClassKey: "C4", price: 44.9, freeSeatsCount: 0 },
    { seatClassKey: "CL", price: 29.9, freeSeatsCount: 5 },
    { seatClassKey: "S2", price: 69.9, freeSeatsCount: 2, bookable: true },
  ],
};
const b = berthClasses(detail, seatInfo);
check("berths priced, cheapest each", eq(b.classes, { couchette6: 34.9, sleeperDouble: 69.9 }), JSON.stringify(b.classes));
check("seat kept beside, never a class", b.seat === 19.9 && !("seat" in b.classes));
check("sold out and ladies-only left out", !("couchette4" in b.classes) && b.verdicts.CL === "excluded");
let detailErr = null;
try {
  berthClasses({ sections: [] });
} catch (err) {
  detailErr = err;
}
check("a connection without priceClasses is an error", detailErr?.shape === true);
check(
  "URLs: stations by booking id, standard adult tariff",
  buildSearchUrl({ fromId: "372825000", toId: "7122901004", date: "2026-10-30" }).includes("fromLocationId=372825000&fromLocationType=STATION&toLocationId=7122901004&toLocationType=STATION") &&
    buildSearchUrl({ fromId: 1, toId: 2, date: "2026-10-30" }).includes("tariffs=REGULAR") &&
    buildRouteUrl({ routeId: "a", fromId: 1, toId: 2 }).endsWith("/routes/a/simple?fromStationId=1&toStationId=2&tariffs=REGULAR"),
);

console.log("fare calendar (fake API)");
const one = { 1021: structuredClone(t21) };
const answers = (url) => {
  if (url.includes("/consts/seatClasses")) return [...seatInfo].map(([key, v]) => ({ key, ...v }));
  if (url.includes("/routes/search/simple")) {
    const date = new URL(url).searchParams.get("departureDate");
    if (date === "2026-10-26") return { routes: [] };
    return { routes: [{ id: `r-${date}`, departureTime: `${date}T21:46:00.000+01:00`, arrivalTime: "x", transfersCount: 0, vehicleTypes: ["TRAIN"] }] };
  }
  if (url.includes("/routes/r-2026-10-27/")) return { priceClasses: [{ seatClassKey: "LC", price: 19.9, freeSeatsCount: 1 }] };
  const date = url.match(/routes\/r-([\d-]+)\//)?.[1];
  return { priceClasses: [{ seatClassKey: "C6", price: date === "2026-10-29" ? 29.9 : 39.9, freeSeatsCount: 4 }, { seatClassKey: "LC", price: 19.9, freeSeatsCount: 10 }] };
};
const fakeFetch = async (url) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(answers(url)) });
const stats = await fillRjFareCalendars(one, null, { today: "2026-10-23", fetchImpl: fakeFetch, log: () => {}, days: 7, spacingMs: 0 });
const cal = one["1021"].fareCalendar;
check("a week priced in one run", Object.keys(cal.nights).length === 7 && stats.priced === 5, JSON.stringify(stats));
check("no train that night", eq(cal.nights["2026-10-26"], { none: true, reason: "noJourney", checkedAt: "2026-10-23" }));
check("seats only that night", cal.nights["2026-10-27"].none && cal.nights["2026-10-27"].reason === "noBerth");
check("a night keeps its seat beside its berths", cal.nights["2026-10-24"].seat === 19.9 && cal.nights["2026-10-24"].classes.couchette6 === 39.9 && cal.nights["2026-10-24"].offers.couchette6 === "C6");
check("headline fare is the cheapest night", one["1021"].fare?.fromPrice === 29.9 && one["1021"].fare.travelDate === "2026-10-29" && one["1021"].fare.currency === "EUR");
const blockedFetch = async () => ({ ok: false, status: 403, headers: new Headers({ "content-type": "text/html" }), text: async () => "<html>Forbidden</html>" });
const two = { 1021: structuredClone(t21) };
const bstats = await fillRjFareCalendars(two, one, { today: "2026-10-23", fetchImpl: blockedFetch, log: () => {}, days: 7, spacingMs: 0 });
check("a refusal stops the pass at once and keeps last run's nights", bstats.blocked?.status === 403 && bstats.requests === 1 && two["1021"].fare?.fromPrice === 29.9);

console.log("published payload");
const pub = read("public/data/published/initial-data.json").data;
const rows = Object.values(pub.viewMap).filter((r) => (r.agency_id || "") === "RJ");
const row7 = rows.find((r) => String(r.route_id) === "7");
const row261 = rows.find((r) => String(r.route_id) === "261");
check("both RegioJet rows stamped by the official feed", [row7, row261].every((r) => r?.timetable_source === "regiojet" && r.official_sources?.includes("regiojet")));
check("the operator's stop list on the row", row7.via_1.split(" - ").length === 16 && row261.via_1.startsWith("Pardubice hl.n. - Olomouc hl.n. - Ostrava-Svinov"));
check("the operator's times on the row", row7.origin_departure_time_1 === "21:46" && row261.origin_departure_time_0 === "21:34");
check("no polyline written over the hand-traced corridors", !row7.nj_polyline_0 && !row261.nj_polyline_0);

console.log("the old client-side merge is gone");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
check(
  "no stale timetable snapshot is fetched or merged",
  !fs.existsSync(path.join(ROOT, "src/lib/rjGtfsMerge.js")) &&
    !fs.existsSync(path.join(ROOT, "public/data/gtfs/rjPremyslTimetable.json")) &&
    !/rjChopTimetable|rjPremyslTimetable|attachRjGtfsToViewMap/.test(
      src("src/hooks/requests/useInitialData.js") + src("src/components/TrainDetailPanel/TrainDetailPanel.js") + src("src/components/Map/DynamicMap.js"),
    ),
);

if (failures) {
  console.log(`\nverify-regiojet: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nverify-regiojet: all checks passed");
