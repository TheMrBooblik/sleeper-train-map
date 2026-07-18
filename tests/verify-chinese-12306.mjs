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
  titleCasePinyin,
} from "../scripts/lib/12306.mjs";
import {
  buildChineseTrains,
  densifyChinesePolylines,
  expandAllowlistLegs,
} from "../scripts/adapters/chinese.mjs";
import {
  densifyPathWithSiblings,
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

console.log(`\n[verify-chinese-12306] ${passed} checks passed`);
