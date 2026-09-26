// tests/verify-chinese-12306.mjs
// Pure unit tests for China Railway 12306 parsers + allowlist expansion
// (no live network). Run: npm run verify-chinese-12306

import assert from "node:assert";
import {
  datePlusDays,
  displayTrainCode,
  findTrainInLeftTicket,
  formatChineseDisplayName,
  makeChineseStationResolver,
  normalizeChineseStations,
  normalizeTrainCode,
  parseLeftTicketRow,
  parseLeftTicketResponse,
  parseQueryByTrainNoResponse,
  parseStationNamesJs,
  parseTicketPriceResponse,
  parseYuan,
  queryTicketPrice,
  ticketPriceUrl,
  titleCasePinyin,
} from "../scripts/lib/12306.mjs";
import { stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";
import {
  buildChineseTrains,
  carryPreviousFares,
  densifyChinesePolylines,
  expandAllowlistLegs,
} from "../scripts/adapters/chinese.mjs";
import {
  densifyPathWithSiblings,
  maxStationDeviationKm,
  stitchPathThroughStations,
  coordPathFromStations,
} from "../scripts/lib/sibling-path.mjs";
import polyline from "@mapbox/polyline";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("normalizeTrainCode: spaces and case", () => {
  assert.strictEqual(normalizeTrainCode("Z 21"), "Z21");
  assert.strictEqual(normalizeTrainCode("z21"), "Z21");
  assert.strictEqual(normalizeTrainCode("T 109"), "T109");
  assert.strictEqual(normalizeTrainCode("K739"), "K739");
});

check("displayTrainCode: inserts space after letter prefix", () => {
  assert.strictEqual(displayTrainCode("Z21"), "Z 21");
  assert.strictEqual(displayTrainCode("T 109"), "T 109");
});

check("parseStationNamesJs: telecode and Chinese name maps", () => {
  const js = `var station_names = '@bjb|北京北|VAP|beijingbei|bjb|0|@bjp|北京|BJP|beijing|bjp|1|';`;
  const { byTelecode, byChineseName } = parseStationNamesJs(js);
  assert.strictEqual(byTelecode.get("BJP").chineseName, "北京");
  assert.strictEqual(byChineseName.get("北京北").telecode, "VAP");
});

check("parseLeftTicketRow: commercial code + train_no + sleeper fields", () => {
  // Minimal pipe row with the stable field indices the web UI uses.
  const parts = new Array(40).fill("");
  parts[0] = "secret";
  parts[2] = "2400000Z210W";
  parts[3] = "Z21";
  parts[4] = "BXP";
  parts[5] = "LSO";
  parts[6] = "BXP";
  parts[7] = "LSO";
  parts[8] = "19:48";
  parts[9] = "11:46";
  parts[10] = "39:58";
  parts[23] = "有";
  parts[28] = "有";
  const row = parseLeftTicketRow(parts.join("|"), { BXP: "北京西", LSO: "拉萨" });
  assert.strictEqual(row.trainCode, "Z21");
  assert.strictEqual(row.trainNo, "2400000Z210W");
  assert.strictEqual(row.fromStation, "北京西");
  assert.strictEqual(row.softSleeper, "有");
  assert.strictEqual(row.hardSleeper, "有");
});

check("parseLeftTicketResponse + findTrainInLeftTicket", () => {
  const parts = new Array(40).fill("");
  parts[2] = "2400000Z210W";
  parts[3] = "Z21";
  parts[6] = "BXP";
  parts[7] = "LSO";
  parts[8] = "19:48";
  parts[9] = "11:46";
  const json = {
    data: {
      result: [parts.join("|")],
      map: { BXP: "北京西", LSO: "拉萨" },
    },
  };
  const { trains } = parseLeftTicketResponse(json);
  assert.strictEqual(trains.length, 1);
  assert.ok(findTrainInLeftTicket(trains, "Z 21"));
  assert.strictEqual(findTrainInLeftTicket(trains, "Z99"), null);
});

check("parseQueryByTrainNoResponse: ---- clocks become null", () => {
  const stops = parseQueryByTrainNoResponse({
    data: {
      data: [
        {
          station_name: "北京西",
          arrive_time: "----",
          start_time: "19:48",
          station_no: "01",
          stopover_time: "----",
        },
        {
          station_name: "拉萨",
          arrive_time: "11:46",
          start_time: "----",
          station_no: "10",
          stopover_time: "----",
        },
      ],
    },
  });
  assert.strictEqual(stops.length, 2);
  assert.strictEqual(stops[0].arrival, null);
  assert.strictEqual(stops[0].departure, "19:48");
  assert.strictEqual(stops[1].arrival, "11:46");
  assert.strictEqual(stops[1].departure, null);
});

check("datePlusDays: UTC calendar arithmetic", () => {
  assert.strictEqual(datePlusDays("2026-07-16", 3), "2026-07-19");
  assert.strictEqual(datePlusDays("2026-01-30", 3), "2026-02-02");
});

check("titleCasePinyin + formatChineseDisplayName", () => {
  assert.strictEqual(titleCasePinyin("shenzhendong"), "Shenzhendong");
  assert.strictEqual(formatChineseDisplayName("Shenzhendong", "深圳东"), "Shenzhendong(深圳东)");
  assert.strictEqual(formatChineseDisplayName("Beijing West", "北京西"), "Beijing West(北京西)");
  assert.strictEqual(formatChineseDisplayName("Beijing West(北京西)", "北京西"), "Beijing West(北京西)");
  assert.strictEqual(formatChineseDisplayName(null, "安多"), "安多");
});

check("station resolver: allowlist English beats pinyin; pinyin fills gaps", () => {
  const stationNames = parseStationNamesJs(
    `var station_names = '@bxp|北京西|BXP|beijingxi|bxp|0|@amd|安多|ADO|anduo|ad|1|';`,
  );
  const resolve = makeChineseStationResolver({
    allowlistStations: [
      { name: "Beijing West", nameZh: "北京西", telecode: "BXP", lat: 39.9, lon: 116.3 },
    ],
    stationNames,
    coordsByZh: { 安多: { lat: 32.2, lon: 91.7 } },
  });
  assert.deepStrictEqual(resolve("北京西"), {
    name: "Beijing West",
    nameZh: "北京西",
    telecode: "BXP",
    coords: { lat: 39.9, lon: 116.3 },
  });
  assert.deepStrictEqual(resolve("安多"), {
    name: "Anduo",
    nameZh: "安多",
    telecode: "ADO",
    coords: { lat: 32.2, lon: 91.7 },
  });
  assert.strictEqual(resolve("未知站"), null);
});

check("normalizeChineseStations: English(中文) + wall-clock times", () => {
  const resolve = makeChineseStationResolver({
    allowlistStations: [
      { name: "Beijing West", nameZh: "北京西", lat: 39.9, lon: 116.3 },
      { name: "Lhasa", nameZh: "拉萨", lat: 29.6, lon: 91.1 },
    ],
  });
  const stations = normalizeChineseStations(
    [
      { nameZh: "北京西", arrival: null, departure: "19:48" },
      { nameZh: "拉萨", arrival: "11:46", departure: null },
    ],
    { resolveStation: resolve, today: "2026-07-19" },
  );
  assert.strictEqual(stations[0].name, "Beijing West(北京西)");
  assert.strictEqual(stations[0].departure, "2026-07-19T19:48:00");
  assert.strictEqual(stations[1].name, "Lhasa(拉萨)");
  assert.strictEqual(stations[1].arrival, "2026-07-19T11:46:00");
  assert.deepStrictEqual(stations[1].location, { latitude: 29.6, longitude: 91.1 });
});

check("expandAllowlistLegs: return direction flips telecodes", () => {
  const legs = expandAllowlistLegs([
    {
      lineName: "Z21",
      returnLineName: "Z22",
      fromTelecode: "BXP",
      toTelecode: "LSO",
      frequency: "Daily",
    },
  ]);
  assert.strictEqual(legs.length, 2);
  assert.deepStrictEqual(
    legs.map((l) => [l.lineName, l.fromTelecode, l.toTelecode]),
    [
      ["Z 21", "BXP", "LSO"],
      ["Z 22", "LSO", "BXP"],
    ],
  );
});

check("buildChineseTrains: live stops win; seedStations on miss", async () => {
  const resolve = makeChineseStationResolver({
    allowlistStations: [
      { name: "Beijing West", nameZh: "北京西", lat: 39.9, lon: 116.3 },
      { name: "Lhasa", nameZh: "拉萨", lat: 29.6, lon: 91.1 },
    ],
  });
  const legs = [
    {
      lineName: "Z 21",
      fromTelecode: "BXP",
      toTelecode: "LSO",
      frequency: "Daily",
    },
    {
      lineName: "K 23",
      fromTelecode: "BJP",
      toTelecode: "RLC",
      frequency: "Mon, Wed, Fri",
      seedStations: [
        { name: "Beijing", nameZh: "北京", lat: 39.9, lon: 116.4 },
        { name: "Ulaanbaatar", lat: 47.9, lon: 106.9 },
      ],
    },
  ];
  const trains = await buildChineseTrains(legs, {
    resolveStation: resolve,
    today: "2026-07-16",
    date: "2026-07-19",
    log: () => {},
    fetchLeg: async (leg) => {
      if (leg.lineName === "Z 21") {
        return {
          trainCode: "Z21",
          trainNo: "2400000Z210W",
          stops: [
            { nameZh: "北京西", arrival: null, departure: "19:48" },
            { nameZh: "拉萨", arrival: "11:46", departure: null },
          ],
        };
      }
      return null; // K 23 missing from leftTicket → seed
    },
  });
  assert.deepStrictEqual(Object.keys(trains).sort(), ["K 23", "Z 21"]);
  assert.strictEqual(trains["Z 21"].stations[0].departure, "2026-07-19T19:48:00");
  assert.strictEqual(trains["Z 21"].stations[0].name, "Beijing West(北京西)");
  assert.strictEqual(trains["K 23"].stations[1].name, "Ulaanbaatar");
  assert.strictEqual(trains["K 23"].stations[0].arrival, null);
  assert.strictEqual(trains["Z 21"].frequency, "Daily");
  assert.strictEqual(trains["Z 21"].agency_id, "CR");
});

check("sibling densify: borrows intermediates across a long jump", () => {
  // Sparse Beijing → Shanghai (~1060 km chord).
  const sparse = [
    [39.9, 116.4],
    [31.25, 121.46],
  ];
  // Denser corridor with Tianjin + Nanjing between the same ends.
  const dense = [
    [39.9, 116.4],
    [39.13, 117.2],
    [32.07, 118.8],
    [31.25, 121.46],
  ];
  const out = densifyPathWithSiblings(sparse, [dense], { gapKm: 400, matchKm: 50 });
  assert.ok(out.length > sparse.length, "should insert sibling waypoints");
  assert.deepStrictEqual(out[0], sparse[0]);
  assert.deepStrictEqual(out[out.length - 1], sparse[1]);
  // Tianjin / Nanjing should appear as hidden path points.
  assert.ok(out.some((p) => Math.abs(p[0] - 39.13) < 0.01));
  assert.ok(out.some((p) => Math.abs(p[0] - 32.07) < 0.01));
});

check("sibling densify: leaves short hops alone", () => {
  const short = [
    [39.9, 116.4],
    [39.13, 117.2],
  ];
  const dense = [
    [39.9, 116.4],
    [39.5, 116.8],
    [39.13, 117.2],
  ];
  const out = densifyPathWithSiblings(short, [dense], { gapKm: 400, matchKm: 50 });
  assert.strictEqual(out.length, short.length);
});

check("densifyChinesePolylines: path-only, stations unchanged", () => {
  const trains = {
    "D 5": {
      stations: [
        { name: "Beijing", location: { latitude: 39.9, longitude: 116.4 } },
        { name: "Shanghai", location: { latitude: 31.25, longitude: 121.46 } },
      ],
      polyline: polyline.encode([
        [39.9, 116.4],
        [31.25, 121.46],
      ]),
    },
    "D 7": {
      stations: [
        { name: "Beijing", location: { latitude: 39.9, longitude: 116.4 } },
        { name: "Tianjin", location: { latitude: 39.13, longitude: 117.2 } },
        { name: "Nanjing", location: { latitude: 32.07, longitude: 118.8 } },
        { name: "Shanghai", location: { latitude: 31.25, longitude: 121.46 } },
      ],
      polyline: null,
    },
  };
  const beforeStations = JSON.stringify(trains["D 5"].stations);
  const n = densifyChinesePolylines(trains);
  assert.strictEqual(n, 1);
  assert.strictEqual(JSON.stringify(trains["D 5"].stations), beforeStations);
  const decoded = polyline.decode(trains["D 5"].polyline);
  assert.ok(decoded.length >= 4);
});

check("outbound/return densify keeps every official station on the path", () => {
  const trains = {
    "D 5": {
      stations: [
        { name: "Beijing", location: { latitude: 39.9, longitude: 116.4 } },
        { name: "Mingguang", location: { latitude: 32.78, longitude: 117.98 } },
        { name: "Shanghai", location: { latitude: 31.25, longitude: 121.46 } },
      ],
    },
    "D 6": {
      stations: [
        { name: "Shanghai", location: { latitude: 31.25, longitude: 121.46 } },
        { name: "Nanjing", location: { latitude: 32.07, longitude: 118.8 } },
        { name: "Beijing", location: { latitude: 39.9, longitude: 116.4 } },
      ],
    },
    "D 9": {
      stations: [
        { name: "Beijing", location: { latitude: 39.9, longitude: 116.4 } },
        { name: "Tianjin", location: { latitude: 39.13, longitude: 117.2 } },
        { name: "Nanjing", location: { latitude: 32.07, longitude: 118.8 } },
        { name: "Shanghai", location: { latitude: 31.25, longitude: 121.46 } },
      ],
    },
  };
  densifyChinesePolylines(trains, { pairs: [["D 5", "D 6"]] });
  for (const code of ["D 5", "D 6"]) {
    const official = coordPathFromStations(trains[code].stations);
    const path = polyline.decode(trains[code].polyline);
    assert.ok(
      maxStationDeviationKm(official, path) < 0.01,
      `${code} stations must lie on polyline`,
    );
    // Mingguang / Nanjing must appear as exact vertices.
    for (const pt of official) {
      assert.ok(path.some((p) => Math.abs(p[0] - pt[0]) < 1e-6 && Math.abs(p[1] - pt[1]) < 1e-6));
    }
  }
});

check("stitchPathThroughStations always keeps official vertices", () => {
  const official = [
    [39.9, 116.4],
    [32.78, 117.98],
    [31.25, 121.46],
  ];
  // Guide corridor that skips Mingguang (goes via Nanjing instead).
  const guide = [
    [39.9, 116.4],
    [39.13, 117.2],
    [32.07, 118.8],
    [31.25, 121.46],
  ];
  const out = stitchPathThroughStations(official, guide, { matchKm: 50 });
  assert.strictEqual(out.length >= official.length, true);
  for (const pt of official) {
    assert.ok(out.some((p) => p[0] === pt[0] && p[1] === pt[1]));
  }
});

// ─── Fares (queryTicketPrice → trains file → row.pricing) ───────────────────

check("parseLeftTicketRow: station_no + seat_types feed the price call", () => {
  const parts = new Array(40).fill("");
  parts[2] = "2400000Z210W";
  parts[3] = "Z21";
  parts[16] = "01";
  parts[17] = "12";
  parts[35] = "4631";
  const row = parseLeftTicketRow(parts.join("|"));
  assert.strictEqual(row.fromStationNo, "01");
  assert.strictEqual(row.toStationNo, "12");
  assert.strictEqual(row.seatTypes, "4631");
});

check("parseYuan: ¥ strings, numbers, junk", () => {
  assert.strictEqual(parseYuan("¥335.5"), 335.5);
  assert.strictEqual(parseYuan("1,234.0"), 1234);
  assert.strictEqual(parseYuan(88), 88);
  assert.strictEqual(parseYuan("--"), null);
  assert.strictEqual(parseYuan(""), null);
  assert.strictEqual(parseYuan([]), null);
});

check("parseTicketPriceResponse: from-price is the cheapest BERTH, never a seat", () => {
  const fare = parseTicketPriceResponse({
    status: true,
    data: { A1: "¥190.0", WZ: "¥190.0", A3: "¥335.5", A4: "¥523.5", A6: "¥1001.0", OT: [], train_no: "x" },
  });
  // Hard seat (A1) and standing (WZ) are cheaper and must not be the sleeper's price.
  assert.strictEqual(fare.fromPrice, 335.5);
  assert.strictEqual(fare.seatClass, "hardSleeper");
  assert.strictEqual(fare.currency, "CNY");
  assert.deepStrictEqual(fare.classes, { hardSleeper: 335.5, softSleeper: 523.5, deluxeSoftSleeper: 1001 });
});

check("parseTicketPriceResponse: EMU sleeper codes; seats-only → null", () => {
  const emu = parseTicketPriceResponse({ data: { O: "¥300", F: "¥612.0", I: "¥900" } });
  assert.strictEqual(emu.fromPrice, 612);
  assert.strictEqual(emu.seatClass, "emuSleeper");
  assert.strictEqual(parseTicketPriceResponse({ data: { A1: "¥90", WZ: "¥90" } }), null);
  assert.strictEqual(parseTicketPriceResponse({ status: false }), null);
});

check("ticketPriceUrl: the endpoint the 12306 web UI calls", () => {
  const url = ticketPriceUrl({ trainNo: "2400000Z210W", fromStationNo: "01", toStationNo: "12", seatTypes: "4631", date: "2026-09-29" });
  assert.strictEqual(
    url,
    "https://kyfw.12306.cn/otn/leftTicket/queryTicketPrice?train_no=2400000Z210W&from_station_no=01&to_station_no=12&seat_types=4631&train_date=2026-09-29",
  );
});

{
  // queryTicketPrice over a mocked fetch: JSON parsed, HTML block page rejected.
  const mk = (body, ok = true) => async () => ({
    ok,
    status: ok ? 200 : 403,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => body,
  });
  const args = { trainNo: "t", fromStationNo: "01", toStationNo: "02", seatTypes: "3", date: "2026-09-29" };
  const ok = await queryTicketPrice(args, { fetchImpl: mk(JSON.stringify({ data: { A3: "¥200.5" } })) });
  assert.strictEqual(ok.fare.fromPrice, 200.5);
  await assert.rejects(queryTicketPrice(args, { fetchImpl: mk("<html>blocked</html>") }), /non-JSON/);
  await assert.rejects(queryTicketPrice(args, { fetchImpl: mk("", false) }), /HTTP 403/);
  passed++;
  console.log("  ✓ queryTicketPrice: parses JSON, rejects block pages and HTTP errors");
}

{
  const station = (name) => ({ nameZh: name, arrival: null, departure: "10:00" });
  const trains = await buildChineseTrains(
    [{ lineName: "Z 21", fromTelecode: "BXP", toTelecode: "LSO" }, { lineName: "Z 22", fromTelecode: "LSO", toTelecode: "BXP" }],
    {
      resolveStation: () => null,
      today: "2026-09-26",
      date: "2026-09-29",
      log: () => {},
      fetchLeg: async (leg) => ({
        stops: [station("北京西"), station("拉萨")],
        fare: leg.lineName === "Z 21" ? { fromPrice: 760.5, currency: "CNY", seatClass: "hardSleeper", sampledAt: "2026-09-26" } : null,
      }),
    },
  );
  assert.strictEqual(trains["Z 21"].fare.fromPrice, 760.5);
  assert.ok(!("fare" in trains["Z 22"]), "a failed price call leaves no fare key, not a null one");
  passed++;
  console.log("  ✓ buildChineseTrains: carries the leg's fare onto the train");
}

check("carryPreviousFares: keeps last night's fare, but not a stale one", () => {
  const trains = { "Z 21": { stations: [] }, "Z 22": { stations: [] }, "K 1": { stations: [], fare: { fromPrice: 5, sampledAt: "2026-09-26" } } };
  const prev = {
    "Z 21": { fare: { fromPrice: 760.5, currency: "CNY", sampledAt: "2026-09-20" } },
    "Z 22": { fare: { fromPrice: 700, currency: "CNY", sampledAt: "2026-07-01" } },
    "K 1": { fare: { fromPrice: 999, sampledAt: "2026-09-25" } },
  };
  const n = carryPreviousFares(trains, prev, { today: "2026-09-26", maxAgeDays: 30 });
  assert.strictEqual(n, 1);
  assert.strictEqual(trains["Z 21"].fare.fromPrice, 760.5);
  assert.strictEqual(trains["Z 21"].fare.sampledAt, "2026-09-20", "carried fare keeps its own date");
  assert.ok(!trains["Z 22"].fare, "older than maxAgeDays is dropped");
  assert.strictEqual(trains["K 1"].fare.fromPrice, 5, "tonight's fare is never overwritten");
});

check("stampOfficialFares: cheaper direction, trusted source only, own rows only", () => {
  const registry = [
    { id: "chinese", enabled: true, official: true, trusted: true },
    { id: "untrusted", enabled: true, official: true, trusted: false },
  ];
  const viewMap = {
    cr_Z_21: { route_id: "cr_Z_21", agency_id: "CR", timetable_source: "chinese", trip_short_name_0: "Z 21", trip_short_name_1: "Z 22" },
    // Same bare label under another source's row must not borrow CR's fare.
    other_Z_21: { route_id: "other_Z_21", agency_id: "XX", timetable_source: "untrusted", trip_short_name_0: "Z 21" },
    bot_row: { route_id: "5", agency_id: "CR", trip_short_name_0: "Z 21" },
    cr_K_1: { route_id: "cr_K_1", agency_id: "CR", timetable_source: "chinese", trip_short_name_0: "K 1", pricing: { fromPrice: 1, source: "manual" } },
  };
  const trips = { t1: { route_id: "cr_Z_21" }, t2: { route_id: "5" } };
  const operatorTrains = {
    chinese: {
      "Z 21": { fare: { fromPrice: 760.5, currency: "CNY", seatClass: "hardSleeper", sampledAt: "2026-09-26" } },
      "Z 22": { fare: { fromPrice: 758, currency: "CNY", seatClass: "hardSleeper", sampledAt: "2026-09-25" } },
      "K 1": { fare: { fromPrice: 120, currency: "CNY", sampledAt: "2026-09-26" } },
    },
    untrusted: { "Z 21": { fare: { fromPrice: 3, currency: "EUR" } } },
  };
  const n = stampOfficialFares(viewMap, trips, operatorTrains, registry);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(viewMap.cr_Z_21.pricing, {
    type: "fixed",
    currency: "CNY",
    fromPrice: 758,
    source: "chinese",
    checkedAt: "2026-09-25",
    seatClass: "hardSleeper",
  });
  assert.strictEqual(trips.t1.pricing.fromPrice, 758);
  assert.ok(!trips.t2.pricing);
  assert.ok(!viewMap.other_Z_21.pricing, "untrusted source never stamps");
  assert.ok(!viewMap.bot_row.pricing, "a row the source did not build is left alone");
  assert.strictEqual(viewMap.cr_K_1.pricing.fromPrice, 120, "official fare outranks a reviewed/manual one");
});

console.log(`\n[verify-chinese-12306] ${passed} checks passed`);
