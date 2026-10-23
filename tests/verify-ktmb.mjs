// tests/verify-ktmb.mjs
// KTM Berhad, Malaysia (scripts/lib/ktmb.mjs, scripts/lib/ktmb-kits.mjs,
// scripts/adapters/ktmb.mjs).
//
// tests/fixtures/ktmb/*.txt is data.gov.my's real KTMB GTFS as the "Probe
// KTMB source" workflow printed it on 2026-10-22 — its agency, routes and
// calendars whole, and every trip that runs through a night (ERT 26 and 27,
// the ERT route's midday Merapoh working 1021, three overnight ETS runs) stop
// by stop, rebuilt into GTFS tables. kits-trip-*.html is KITS's real /Trip/Trip
// answer for JB Sentral ⇄ Tumpat, travel on 2026-10-29. The KITS search page
// and results page served by the fake fetch below are synthetic and minimal:
// only the fields the client reads, in the shape the probe printed.
//
// Run: node tests/verify-ktmb.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  buildKtmbTrains,
  clockOf,
  fareRecord,
  gtfsMinutes,
  makeStationNamer,
  nightTrips,
  pairOrder,
  serviceDays,
  serviceEnd,
} from "../scripts/lib/ktmb.mjs";
import { inputValue, kitsFormDate, parseStations, parseTripRows } from "../scripts/lib/ktmb-kits.mjs";
import { loadKtmbFeed, run } from "../scripts/adapters/ktmb.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "tests/fixtures/ktmb");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/ktmb-sleepers.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
const entry = registry.find((e) => e.id === "ktmb");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("names and clocks");
const namer = makeStationNamer(config.stationNames);
check("capitals title-cased, JB kept", namer("JB SENTRAL") === "JB Sentral" && namer("KUALA LIPIS") === "Kuala Lipis" && namer("WAKAF BHARU") === "Wakaf Bharu");
check("a configured spelling wins", namer("woodlands ciq") === "Woodlands CIQ");
check("dotted and hyphenated words", namer("KG. SIRIAN") === "Kg. Sirian" && namer("PULAU SEBANG/TAMPIN") === "Pulau Sebang/Tampin");
check("GTFS 24+ hours", gtfsMinutes("35:25:00") === 35 * 60 + 25 && gtfsMinutes("") === null);
check("a clock past midnight carries its day", eq(clockOf(35 * 60 + 25), { time: "11:25", day: 1 }) && eq(clockOf(19 * 60 + 30), { time: "19:30", day: 0 }));

console.log("the feed (real)");
const feed = await loadKtmbFeed({ local: FIX });
check("routes, trips and stops read", feed.routes.length === 9 && feed.trips.length === 6 && feed.stopsById.size > 40, `${feed.routes.length}/${feed.trips.length}/${feed.stopsById.size}`);
const { trains, skipped } = nightTrips(feed, config, namer);
check("the Ekspres Rakyat Timuran, both directions", eq([...trains.keys()].sort(), ["26", "27"]), JSON.stringify([...trains.keys()]));
check("the ERT route's midday Merapoh working is not a night train", skipped.some((s) => s.startsWith("1021 ")) && !trains.has("1021"));
check("overnight ETS runs (seated, another route) stay out", !trains.has("1004") && !trains.has("9238") && !trains.has("9256"));
const t26 = trains.get("26");
check("26: JB Sentral 19:30 → Tumpat 11:25 next morning, 23 stops", t26.stops[0].name === "JB Sentral" && t26.stops.at(-1).name === "Tumpat" && t26.stops.length === 23 && t26.stops[0].depMin === 1170 && t26.stops.at(-1).arrMin === 35 * 60 + 25);
check("26 rides 15 h 55 min", t26.durationMinutes === 955, String(t26.durationMinutes));
check("27 rides 15 h 45 min", trains.get("27").durationMinutes === 945);
check("every stop has a position", [...trains.values()].every((t) => t.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))));
check("daily, from the weekday columns", serviceDays(["intercity"], feed.calendar) === "Daily");
check("weekdays listed when not daily", serviceDays(["komuter_weekday"], feed.calendar) === "Mon, Tue, Wed, Thu, Fri");
check("unknown service → null", serviceDays(["nope"], feed.calendar) === null);
check("the feed's window end is read, not published as a season", serviceEnd(["intercity"], feed.calendar) === "2026-11-06");
const allowEts = nightTrips(feed, { ...config, routes: ["ETS"] }, namer);
check("the rule itself would take an overnight ETS run if its route were allowlisted", allowEts.trains.has("1004") && allowEts.trains.has("9256"));
check("pairs: n then n+1", eq(pairOrder(["27", "26"]), ["26", "27"]) && eq(pairOrder(["27", "26", "41"]), ["26", "27", "41"]));

console.log("the trains file");
for (const t of trains.values()) t.frequency = serviceDays([t.serviceId], feed.calendar);
const built = buildKtmbTrains({ config, feedTrains: trains, today: "2026-10-22", travelDate: "2026-10-29" });
check("keyed by service and number, outbound first", eq(Object.keys(built), ["ERT 26", "ERT 27"]), JSON.stringify(Object.keys(built)));
const b26 = built["ERT 26"];
check("operator and agency", b26.operator === "KTM Berhad" && b26.agency_id === "KTMB" && b26.service === "Ekspres Rakyat Timuran");
check("ends carry only their own time, the arrival a day later", b26.stations[0].departure === "19:30" && b26.stations[0].arrival === null && b26.stations.at(-1).arrival === "11:25" && b26.stations.at(-1).arrivalDay === 1 && b26.stations.at(-1).departure === null);
const krai = b26.stations.find((s) => s.name === "Krai");
check("a stop after midnight is timed on day 1", krai?.arrival === "09:23" && krai?.departure === "09:25" && krai?.arrivalDay === 1);
check("journey time and nights", b26.durationMinutes === 955 && b26.nights === 1 && b26.frequency === "Daily");
check("without OSM the line is the station chain, every stop a vertex", polyline.decode(b26.polyline).length === 23 && b26.geometry.chord === 22);
check("no fare without a berth price", !("fare" in b26));
check("a berth record when one is known", eq(fareRecord({ ktmbBerthUpper: 50, ktmbBerthLower: 60 }, { sampledAt: "a", travelDate: "b" }), { fromPrice: 50, currency: "MYR", seatClass: "ktmbBerthUpper", classes: { ktmbBerthUpper: 50, ktmbBerthLower: 60 }, sampledAt: "a", travelDate: "b" }));
const carried = buildKtmbTrains({ config, feedTrains: null, previous: built, today: "2026-11-10", travelDate: "2026-11-17" });
check("a night without the feed carries last night's trains", eq(Object.keys(carried), ["ERT 26", "ERT 27"]) && carried["ERT 26"].timetable.source === "previous");
check("…but not after a month", !Object.keys(buildKtmbTrains({ config, feedTrains: null, previous: built, today: "2026-12-01", travelDate: "2026-12-08" })).length);

console.log("KITS (real /Trip/Trip answers)");
const rows26 = parseTripRows(fs.readFileSync(path.join(FIX, "kits-trip-37500-86300.html"), "utf8"));
check(
  "JB Sentral → Tumpat: Express 26, 19:30 → 11:25 +1, min. fare MYR 56, login to view",
  eq(rows26, [{ service: "Express", number: "26", departure: "19:30", arrival: "11:25", nextDay: 1, available: 71, minFare: 56, bookable: false }]),
  JSON.stringify(rows26),
);
const rows27 = parseTripRows(fs.readFileSync(path.join(FIX, "kits-trip-86300-37500.html"), "utf8"));
check("Tumpat → JB Sentral: Express 27, 20:55 → 12:40 +1", rows27.length === 1 && rows27[0].number === "27" && rows27[0].departure === "20:55" && rows27[0].arrival === "12:40");
check("KITS and the feed agree on 26's ends", rows26[0].departure === clockOf(t26.stops[0].depMin).time && rows26[0].arrival === clockOf(t26.stops.at(-1).arrMin).time);
check("form date", kitsFormDate("2026-10-29") === "29 Oct 2026" && kitsFormDate("2026-11-01") === "1 Nov 2026");
check("input values, entity-decoded", inputValue('<input type="hidden" id="SearchData" name="SearchData" value="a&#x2B;b/c=" />', "SearchData") === "a+b/c=");
check("station blobs", eq(parseStations('var jsStations = [{"Id":"37500","StationData":"x\\u002By"}];'), [{ Id: "37500", StationData: "x+y" }]));

console.log("the adapter, end to end (fake hosts)");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ktmb-verify-"));
  fs.mkdirSync(path.join(root, "data/sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "public/data/scraped"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, entry.params.configPath), path.join(root, entry.params.configPath));
  const home = `<form id="theForm"><input name="__RequestVerificationToken" type="hidden" value="tok" /></form><script>var jsStations = [{"Id":"37500","StationData":"jb"},{"Id":"86300","StationData":"tp"}];</script>`;
  const results = `<input type="hidden" id="SearchData" name="SearchData" value="sd" /><input type="hidden" id="FormValidationCode" name="FormValidationCode" value="fv" /><input name="__RequestVerificationToken" type="hidden" value="tok2" />`;
  const asked = [];
  let lastFrom = null;
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    asked.push(`${opts.method ?? "GET"} ${u.replace(/^https:\/\/[^/]+/, "")}`);
    const ok = (body, type = "text/html") => new Response(body, { status: 200, headers: { "content-type": type } });
    if (u.startsWith("https://online.ktmb.com.my/")) {
      const p = new URL(u).pathname;
      if (p === "/") return ok(home);
      if (p === "/Trip") {
        lastFrom = new URLSearchParams(opts.body).get("FromStationId");
        return ok(results);
      }
      if (p === "/Trip/Trip") {
        const body = JSON.parse(opts.body);
        if (body.SearchData !== "sd" || body.DepartDate !== "2026-10-29" || opts.headers.RequestVerificationToken !== "tok2") return ok(JSON.stringify({ status: false, messages: ["bad"] }), "application/json");
        const file = lastFrom === "37500" ? "kits-trip-37500-86300.html" : "kits-trip-86300-37500.html";
        return ok(JSON.stringify({ status: true, data: fs.readFileSync(path.join(FIX, file), "utf8") }), "application/json");
      }
    }
    return new Response("busy", { status: 503 });
  };
  process.env.KTMB_GTFS_ZIP = FIX;
  const written = {};
  const quiet = console.log;
  const lines = [];
  console.log = (m) => lines.push(String(m));
  let result;
  try {
    result = await run(
      { ...entry, params: { ...entry.params, kits: { ...entry.params.kits, spacingMs: 0 }, osmTrack: { ...entry.params.osmTrack, budgetMs: 0 } } },
      { rootDir: root, today: "2026-10-22", fetch: fakeFetch, write: (name, data) => (written[name] = data) },
    );
  } finally {
    console.log = quiet;
    delete process.env.KTMB_GTFS_ZIP;
  }
  const out = written[entry.output];
  check("writes both trains", eq(Object.keys(out?.trains ?? {}), ["ERT 26", "ERT 27"]), lines.join("\n"));
  check("KITS confirms both at the feed's times, min. fare kept beside the train", out?.trains["ERT 26"]?.kits?.agrees === true && out?.trains["ERT 26"]?.kits?.minFare === 56 && out?.trains["ERT 27"]?.kits?.agrees === true);
  check("…and the min. fare is never published as a fare", !out?.trains["ERT 26"]?.fare && !out?.trains["ERT 27"]?.fare);
  check("one search page, one search each way", asked.filter((a) => a === "GET /").length === 1 && asked.filter((a) => a === "POST /Trip").length === 2);
  check("Overpass unreachable is a log line, not a failure", lines.some((l) => /OSM track/.test(l)) && !result?.warning?.includes("OSM"));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("the published payload");
{
  const file = path.join(ROOT, "public/data/published/initial-data.json");
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const viewMap = (payload.data ?? payload).viewMap ?? {};
  const rows = Object.values(viewMap).filter((r) => String(r.route_id).startsWith("ktmb_"));
  if (!rows.length) {
    console.log("  (no ktmb_ rows published yet — run `SCRAPE_ONLY=ktmb npm run scrape` where data.gov.my is reachable, then canonicalize)");
  } else {
    const ert = rows.find((r) => r.trip_short_name_0 === "ERT 26");
    check("one row for both directions", rows.length === 1 && ert?.trip_short_name_1 === "ERT 27", JSON.stringify(rows.map((r) => r.route_id)));
    check("JB Sentral – Tumpat, KTMB, daily", ert.origin_trip_0 === "JB Sentral" && ert.destination_trip_0 === "Tumpat" && ert.agency_id === "KTMB" && ert.service_id_0 === "Daily");
    check("journey time stated (clocks alone cannot say a day passed)", ert.duration_minutes_0 > 900 && ert.duration_minutes_1 > 900);
    check("timed from its own trains file", ert.timetable_source === "ktmb");
    check("no seat price stamped as a fare", !ert.pricing?.fromPrice && !ert.fare_0 && !ert.fare_1);
  }
}

if (failures) {
  console.log(`\nverify-ktmb: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nverify-ktmb: all checks passed");
