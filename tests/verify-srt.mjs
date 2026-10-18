// tests/verify-srt.mjs
// State Railway of Thailand (scripts/lib/srt.mjs + scripts/adapters/srt.mjs).
//
// The D-Ticket fixtures in tests/fixtures/srt/ are REAL answers, captured by
// the "Probe SRT source" workflow on 2026-10-18 (Krung Thep Aphiwat → Chiang
// Mai, travel on 2026-10-28): the trip list, train 9's coach list (CNR sleeper)
// and train 7's (a day train selling seats only). The Namtang feed is
// hand-built here in its real shape (bilingual "SRT ไทย;SRT English" names,
// placeholder minute-per-stop times), because the real one is 41 MB.
//
// Run: node tests/verify-srt.mjs

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  berthFares,
  bilingualName,
  buildSrtTrains,
  fareRecord,
  isPlaceholderTiming,
  makeStationNamer,
  namtangTrains,
  pairOrder,
  parseTrips,
  pickCorridorTrains,
  routeTrainNumber,
  serviceName,
  stationPositions,
  tripMinutes,
} from "../scripts/lib/srt.mjs";
import { run } from "../scripts/adapters/srt.mjs";
import { FARE_CLASS_LABELS, formatMoney } from "../src/lib/fareClasses.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/srt", name), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/srt-sleepers.json"), "utf8"));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("names");
check("bilingual Namtang name, tab and prefix stripped", eq(bilingualName("SRT ชุมทางหาดใหญ่\t;SRT Hat Yai Junction\t"), { th: "ชุมทางหาดใหญ่", en: "Hat Yai Junction" }));
const namer = makeStationNamer(config.stationNames);
check("Namtang's Bangkok terminus and D-Ticket's agree, city first", namer("Krung Thep Aphiwat") === "Bangkok (Krung Thep Aphiwat)" && namer("Krung Thep Aphiwat Central Terminal Station [Red Line]") === "Bangkok (Krung Thep Aphiwat)" && namer("Bangkok (Krung Thep Aphiwat)") === "Bangkok (Krung Thep Aphiwat)");
check("one spelling for Su-ngai Kolok from both sources", namer("Su-Ngai Kolok") === "Su-ngai Kolok");
check("route number from a Namtang short name", routeTrainNumber("9 ด่วนพิเศษ") === "9" && routeTrainNumber("102") === "102" && routeTrainNumber("รถเร็ว") === null);
check("service names", serviceName("SPECIAL EXPRESS CNR") === "Special Express" && serviceName("EXPRESS") === "Express" && serviceName("RAPID") === "Rapid");

console.log("Namtang placeholder times");
const placeholder = Array.from({ length: 13 }, (_, i) => ({ stop_sequence: String(i + 1), arrival_time: `00:0${Math.min(i, 9)}:00`, departure_time: `00:0${Math.min(i, 9)}:00` }));
check("a 13-stop trip filed as 00:00 → 00:07 is a placeholder", isPlaceholderTiming(placeholder));
check("a real timetable is not", !isPlaceholderTiming([{ departure_time: "18:41:00" }, { departure_time: "19:10:00" }, { departure_time: "20:30:00" }]));

console.log("D-Ticket trips (real answer)");
const trips = parseTrips(fixture("gettrip-krung-thep-aphiwat-chiang-mai.json"));
check("five trains on the corridor", trips?.length === 5, JSON.stringify(trips?.map((t) => t.trainNo)));
const t9 = trips.find((t) => t.trainNo === "9");
check("train 9: 18:40 → 07:15 next day", t9?.departure === "18:40" && t9?.arrival === "07:15" && t9?.nights === 1);
check("train 9 rides 12 h 35 min", tripMinutes(t9) === 755, String(tripMinutes(t9)));
check("train 7 is a day train", trips.find((t) => t.trainNo === "7")?.nights === 0);
check("an error answer is null, not 'no trains'", parseTrips({ errorCode: "E_EXCEPTION", data: null }) === null);

console.log("D-Ticket fares (real answers)");
const fares9 = berthFares(fixture("coaches-9.json"), config.fareClasses);
check(
  "train 9: every berth class at the operator's fare",
  eq(fares9, { srtFirstPrivate: 2446, srtFirstLower: 1646, srtFirstUpper: 1446, srtSecondLower: 1038, srtSecondUpper: 938 }),
  JSON.stringify(fares9),
);
check("train 7 sells seats only: no berth, no fare", eq(berthFares(fixture("coaches-7.json"), config.fareClasses), {}));
const cheaperWomen = fixture("coaches-9.json");
const women = cheaperWomen.data.results.find((c) => /สตรี/.test(c.coachDesc));
women.coachSeats.forEach((s) => (s.seatFeeAmt = 1));
check("a women-and-children coach never sets the fare", berthFares(cheaperWomen, config.fareClasses).srtSecondUpper === 938);
check("an unreadable coach answer is null", berthFares({ errorCode: "S_SUCCESS", data: {} }, config.fareClasses) === null);
const record = fareRecord(fares9, { sampledAt: "2026-10-18", travelDate: "2026-10-28" });
check("fare record: from the cheapest berth, in baht", record.fromPrice === 938 && record.currency === "THB" && record.seatClass === "srtSecondUpper");
check("every class the config can emit has a label", Object.entries(config.fareClasses).filter(([k]) => !k.startsWith("_")).every(([, key]) => FARE_CLASS_LABELS[key]));
check("baht fares read ฿1,038", formatMoney(1038, "THB") === "฿1,038");

console.log("which trains a corridor contributes");
const faresByTrip = new Map(trips.map((t) => [t.tripId, t.trainNo === "7" ? {} : fares9]));
const picked = pickCorridorTrains([
  { from: "Krung Thep Aphiwat", to: "Chiang Mai", trips, faresByTrip },
  // The same train 9 found on a shorter corridor (as 37 is on Bangkok–Hat Yai):
  {
    from: "Krung Thep Aphiwat",
    to: "Den Chai",
    trips: [{ ...t9, tripId: "x", arrival: "03:00" }],
    faresByTrip: new Map([["x", { srtSecondUpper: 600 }]]),
  },
]);
check("overnight trains with a berth are kept, the day train is not", eq([...picked.keys()].sort(), ["109", "13", "51", "9"]));
check("a train on two corridors is filed under the one it rides longest", picked.get("9").to === "Chiang Mai" && picked.get("9").classes.srtSecondUpper === 938);
check("pairs in file order, 109's return is 102", eq(pairOrder(["102", "13", "9", "10", "109", "14"], config.pairs), ["9", "10", "13", "14", "109", "102"]));

console.log("building the trains file");
const S = (id, th, en, lat, lon) => [id, { stop_id: id, stop_name: `SRT ${th};SRT ${en}`, stop_lat: String(lat), stop_lon: String(lon) }];
const stopsById = new Map([
  S("1", "กรุงเทพอภิวัฒน์", "Bangkok (Krung Thep Aphiwat)", 13.80559, 100.54229),
  S("2", "พิษณุโลก", "Phitsanulok", 16.81501, 100.26567),
  S("3", "เชียงใหม่", "Chiang Mai", 18.78299, 99.01662),
]);
const feed = {
  routes: [
    { route_id: "r9", agency_id: "SRT", route_short_name: "9 ด่วนพิเศษ" },
    { route_id: "r9s", agency_id: "SRT", route_short_name: "9" },
    { route_id: "bts", agency_id: "BTSC", route_short_name: "9" },
  ],
  trips: [
    { route_id: "r9", trip_id: "t9", shape_id: "s9" },
    { route_id: "r9s", trip_id: "t9s", shape_id: "" },
  ],
  stopTimesByTrip: new Map([
    ["t9", ["1", "2", "3"].map((id, i) => ({ trip_id: "t9", stop_id: id, stop_sequence: String(i + 1), departure_time: `00:0${i}:00` }))],
    ["t9s", [{ trip_id: "t9s", stop_id: "1", stop_sequence: "1", departure_time: "18:41:00" }]],
  ]),
  stopsById,
  shapesById: new Map([["s9", [[13.80559, 100.54229], [15.2, 100.3], [16.81501, 100.26567], [17.9, 99.9], [18.78299, 99.01662]]]]),
};
const namtang = namtangTrains(feed, namer);
check("the full trip wins over the same number's Bangkok stub; other agencies ignored", namtang.get("9")?.stops.length === 3 && namtang.size === 1);
check("its times are recognised as placeholders", namtang.get("9").placeholderTimes === true);
const positions = stationPositions(namtang, config);
check("termini Namtang lacks take the config's position", positions.has("Trang") && positions.has("Chiang Mai"));
const built = buildSrtTrains({ config, found: picked, namtang, positions, today: "2026-10-18", travelDate: "2026-10-28" });
const sp9 = built["Special Express 9"];
check("train 9 built with Namtang's stops", sp9?.stations.map((s) => s.name).join(">") === "Bangkok (Krung Thep Aphiwat)>Phitsanulok>Chiang Mai");
check("only the ends carry a time, D-Ticket's", sp9.stations[0].departure === "18:40" && sp9.stations[2].arrival === "07:15" && sp9.stations[1].departure === null && sp9.stations[1].arrival === null);
const path9 = polyline.decode(sp9.polyline);
check("the line follows Namtang's track (more than the stops)", path9.length > 3, String(path9.length));
check("fare and agency on the train", sp9.fare.fromPrice === 938 && sp9.agency_id === "SRT" && sp9.frequency === "Daily");
check("a train Namtang has no full trip for keeps just its two ends", built["Rapid 109"]?.stations.length === 2);
check("…and still draws along SRT track", polyline.decode(built["Rapid 109"].polyline).length > 2);
check("file order puts each train before its return", Object.keys(built)[0] === "Special Express 9");

console.log("a night D-Ticket cannot be reached");
const rebuilt = buildSrtTrains({ config, found: null, namtang, positions, previous: built, today: "2026-10-19", travelDate: "2026-10-29" });
check("last night's trains, times and fares are kept", rebuilt["Special Express 9"]?.stations[0].departure === "18:40" && rebuilt["Special Express 9"].fare.fromPrice === 938);
check("…and say so, keeping the night it was last confirmed", rebuilt["Special Express 9"].timetable.source === "previous" && rebuilt["Special Express 9"].timetable.checkedAt === "2026-10-18");
const monthLater = buildSrtTrains({ config, found: null, namtang, positions, previous: rebuilt, today: "2026-11-18", travelDate: "2026-11-25" });
check("a timetable unconfirmed for over 30 days is no longer published", Object.keys(monthLater).length === 0);

console.log("adapter against a fake D-Ticket");
{
  const answers = {
    "home/Home": { text: "<html></html>" },
    "home/Home/getStation": { json: { errorCode: "S_SUCCESS", data: [{ stationId: "1679", stationNameEn: "Krung Thep Aphiwat" }, { stationId: "74", stationNameEn: "Chiang Mai" }] } },
    "booking/booking": { text: "<html></html>" },
  };
  const seen = [];
  const fakeFetch = async (url, opts) => {
    const rel = url.replace("https://dticket.railway.co.th/DTicketPublicWeb/", "");
    seen.push({ rel, ua: opts.headers["User-Agent"] });
    const body = opts.body ? new URLSearchParams(opts.body) : null;
    let text = answers[rel]?.text ?? JSON.stringify(answers[rel]?.json ?? {});
    if (rel === "booking/booking/getTrip") {
      text = body.get("provinceStartId") === "1679" ? JSON.stringify(fixture("gettrip-krung-thep-aphiwat-chiang-mai.json")) : JSON.stringify({ errorCode: "S_SUCCESS", data: [] });
    }
    if (rel === "booking/booking/getTrainCoach") text = JSON.stringify(fixture(body.get("tripId") === "592393" ? "coaches-7.json" : "coaches-9.json"));
    return new Response(text, { status: 200, headers: { "content-type": rel.includes("/get") ? "application/json" : "text/html" } });
  };
  const { readDTicket, makeDTicketClient } = await import("../scripts/adapters/srt.mjs");
  const client = makeDTicketClient("https://dticket.railway.co.th/DTicketPublicWeb/", { fetchImpl: fakeFetch, spacingMs: 0 });
  const got = await readDTicket({ config: { ...config, corridors: ["Chiang Mai"] }, client, travelDate: "2026-10-28", log: () => {} });
  const kept = pickCorridorTrains(got);
  check("four sleepers read through the adapter's own calls", eq([...kept.keys()].sort(), ["109", "13", "51", "9"]));
  // Five trains on the corridor, four overnight: the day train's coaches are never asked for.
  check("coaches asked for the overnight trains only", seen.filter((s) => s.rel === "booking/booking/getTrainCoach").length === 4);
  check("every request names itself honestly", seen.every((s) => /Pingwi/.test(s.ua)));

  const blockFetch = async () => new Response("<html><title>Just a moment...</title></html>", { status: 403, headers: { "content-type": "text/html" } });
  const blocked = makeDTicketClient("https://dticket.railway.co.th/DTicketPublicWeb/", { fetchImpl: blockFetch, spacingMs: 0 });
  let threw = null;
  try {
    await readDTicket({ config, client: blocked, travelDate: "2026-10-28", log: () => {} });
  } catch (err) {
    threw = err.message;
  }
  check("a block stops the pass on the first request", /blocked/.test(threw ?? "") && blocked.requests === 1, `${threw} after ${blocked.requests}`);
  check("run() exists", typeof run === "function");
}

console.log("routing along track (rail-graph)");
{
  const { buildRailGraph, routeBetween, routeThroughStops, simplifyPath, trackFromOverpass, km } = await import("../scripts/lib/rail-graph.mjs");
  const line = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  // A main line south from Bangkok with a bend, and a branch west from a
  // junction on it — the shape of the line to Trang off the Southern Line.
  const bangkok = [13.8, 100.54];
  const bend = [11.0, 99.4];
  const junction = [8.17, 99.68];
  const trang = [7.56, 99.61];
  const main = [...line(bangkok, bend, 60), ...line(bend, junction, 60).slice(1)];
  const branch = line(junction, trang, 20);
  const graph = buildRailGraph([main, branch], { joinMeters: 30 });
  const routed = routeBetween(graph, bangkok, trang);
  const along = routed ? routed.slice(1).reduce((n, p, i) => n + km(routed[i], p), 0) : 0;
  const viaTrack = km(bangkok, bend) + km(bend, junction) + km(junction, trang);
  check("an endpoints-only train runs along the main line and down the branch", routed && Math.abs(along - viaTrack) < 5, `${along.toFixed(0)} vs ${viaTrack.toFixed(0)} km`);
  check("…its stations are the line's first and last vertex", routed && eq(routed[0], bangkok) && eq(routed.at(-1), trang));
  // Two overlapping shapes that share no vertex (a feed's shapes do this).
  const offset = line([bend[0] + 0.0004, bend[1]], junction, 40);
  const shapes = buildRailGraph([line(bangkok, bend, 30), offset], { joinMeters: 150 });
  check("shapes overlapping without a shared vertex are joined into one network", Boolean(routeBetween(shapes, bangkok, junction)));
  check("a station far from any track is not routed", routeBetween(graph, bangkok, [12.0, 102.5]) === null);
  const loop = buildRailGraph([[...line(bangkok, [13.8, 104], 30), ...line([13.8, 104], [13.0, 104], 10).slice(1), ...line([13.0, 104], [13.0, 100.54], 30).slice(1)]], { joinMeters: 0 });
  check("a route far longer than the straight line is refused", routeBetween(loop, bangkok, [13.0, 100.54]) === null);
  const through = routeThroughStops([bangkok, junction, [12.0, 102.5]], [["osm", graph]]);
  check("each gap says where its line came from", eq(through.sources, ["osm", "chord"]));
  // The branch missing from the track (Namtang has no shape for it) and the
  // main line running on past the junction by Cha Uat to Phatthalung, as it
  // does: the line follows the rails to the junction and only the branch is
  // straight — not from the earliest point the straight part could start,
  // which is what an unweighted cost picks (a chord is always shorter).
  const chaUat = [7.97, 100.03];
  const phatthalung = [7.62, 100.07];
  const noBranch = buildRailGraph([[...main, ...line(junction, chaUat, 10).slice(1), ...line(chaUat, phatthalung, 10).slice(1)]], { joinMeters: 30 });
  const partial = routeThroughStops([bangkok, trang], [["namtang", noBranch]]);
  const leaves = partial.path.at(-2);
  check("a branch the track lacks: rails to the junction, straight down the branch", eq(partial.sources, ["partial"]) && km(leaves, junction) < 10 && Math.abs(partial.chordKm[0] - km(junction, trang)) < 10, `leaves at ${leaves}, ${partial.chordKm} km straight`);
  const back = routeThroughStops([trang, bangkok], [["namtang", noBranch]]);
  check("…and the same from the branch end", eq(back.sources, ["partial"]) && km(back.path[1], junction) < 10 && eq(back.path[0], trang));
  const zig = line([0, 0], [0, 1], 100);
  check("simplifying keeps a junction it is told to", simplifyPath(zig, 15, new Set([37])).some((p) => eq(p, zig[37])) && simplifyPath(zig, 15).length === 2);
  const overpass = {
    elements: [
      { type: "way", nodes: [1, 2, 3, 4, 5], geometry: line([0, 0], [0, 0.04], 4).map(([lat, lon]) => ({ lat, lon })) },
      { type: "way", nodes: [3, 6], geometry: [{ lat: 0, lon: 0.02 }, { lat: 0.02, lon: 0.02 }] },
    ],
  };
  const ways = trackFromOverpass(overpass);
  check("a node two OSM ways share survives simplification", ways[0].some((p) => eq(p, [0, 0.02])));
}

console.log("registry and wiring");
// ─── OSM track, in tiles ─────────────────────────────────────────────────────
{
  const { bboxTiles, loadOsmTrack } = await import("../scripts/adapters/srt.mjs");
  const tiles = bboxTiles([5.6, 97.3, 20.6, 106.0]);
  check("Thailand's box cut into equal 3° tiles that cover it exactly", tiles.length === 15 && tiles.every(([s, w, n, e]) => n - s <= 3 + 1e-9 && e - w <= 3 + 1e-9) && tiles[0][0] === 5.6 && tiles[0][1] === 97.3 && tiles.at(-1)[2] === 20.6 && tiles.at(-1)[3] === 106);
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srt-osm-"));
  fs.mkdirSync(path.join(root, "public/data/scraped"), { recursive: true });
  const cacheFile = path.join(root, "public/data/scraped/osm-test.json");
  // 150 ways, each answered by every tile its box touches: the merge keeps one copy.
  const way = (id) => ({ type: "way", id, nodes: [id * 10, id * 10 + 1], geometry: [{ lat: 13 + id / 1000, lon: 100 }, { lat: 13 + id / 1000, lon: 100.01 }] });
  const answer = (ids) => new Response(JSON.stringify({ elements: ids.map(way) }), { status: 200 });
  let calls = 0;
  const answering = async () => { calls++; return answer(Array.from({ length: 150 }, (_, i) => i)); };
  const params = { bbox: [5.6, 97.3, 13.6, 101.3], tileDeg: 4, file: "osm-test.json" };
  const got = await loadOsmTrack({ rootDir: root, today: "2026-10-18", params, fetchImpl: answering, retryMs: 0 });
  check("every tile asked once, ways merged by id", calls === 2 && got?.length === 150);
  const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  check("each tile is cached with its own date", Object.values(cached.data.tiles).length === 2 && Object.values(cached.data.tiles).every((t) => t.fetchedAt === "2026-10-18" && t.ways.length === 150));
  calls = 0;
  await loadOsmTrack({ rootDir: root, today: "2026-10-20", params, fetchImpl: answering, retryMs: 0 });
  check("a cache under a week old is used without asking", calls === 0);
  // The first tile answers with new track, the second refuses every attempt:
  // the first is refreshed, the second keeps last week's copy.
  let n = 0;
  const flaky = async () => (n++ === 0 ? answer(Array.from({ length: 10 }, (_, i) => 1000 + i)) : new Response("busy", { status: 502 }));
  const mixed = await loadOsmTrack({ rootDir: root, today: "2026-11-01", params, fetchImpl: flaky, retryMs: 0 });
  const after = Object.values(JSON.parse(fs.readFileSync(cacheFile, "utf8")).data.tiles);
  check("a refused tile keeps its own copy while the others refresh", mixed?.length === 160 && n === 4 && eq(after.map((t) => t.fetchedAt), ["2026-11-01", "2026-10-18"]));
  fs.rmSync(cacheFile);
  const none = await loadOsmTrack({ rootDir: root, today: "2026-11-01", params, fetchImpl: async () => new Response("busy", { status: 500 }), retryMs: 0 });
  check("no tile ever answered: no OSM track, and no cache written", none === null && !fs.existsSync(cacheFile));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const { cardNameForStation, cityForStation } = await import("../src/lib/seo/cities.mjs");
  const bkk = "Bangkok (Krung Thep Aphiwat)";
  check("Bangkok's terminus: city first in stop lists, plain Bangkok on cards and bottom-bar chips, /bangkok in URLs", cardNameForStation(bkk) === "Bangkok" && cityForStation(bkk) === "Bangkok" && cardNameForStation("Hat Yai Junction") === "Hat Yai");
  const bar = fs.readFileSync(path.join(ROOT, "src/components/TrainBottomBar/TrainBottomBar.js"), "utf8");
  check("…and the bottom bar names a chip's ends through it", /chipName\(route\.origin\)/.test(bar) && /chipName\(route\.destination\)/.test(bar));
}

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
const entry = registry.find((e) => e.id === "srt");
check("registry entry: enabled, official, agency SRT, prefix srt_", entry?.enabled && entry.official && entry.synthetic?.idPrefix === "srt_" && entry.agencyDefaults?.agencyId === "SRT");
check("its endpoint is the Ministry of Transport's own feed", entry.endpoint === entry.params.feedUrl && /otp\.go\.th/.test(entry.endpoint));
check("the probe workflow exists", fs.existsSync(path.join(ROOT, ".github/workflows/probe-srt.yml")));

if (failures) {
  console.error(`\nverify-srt: ${failures} problem(s)`);
  process.exit(1);
}
console.log("\nverify-srt: all checks passed");
