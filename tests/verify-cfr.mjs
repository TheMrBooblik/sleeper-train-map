// tests/verify-cfr.mjs
// Pure unit tests for the CFR Călători open-data timetable source
// (scripts/lib/cfr-mers-tren.mjs + the adapter's pure helpers). No network.
// Run: npm run verify-cfr
import assert from "node:assert";
import zlib from "node:zlib";
import fs from "node:fs/promises";
import {
  buildCfrTrains,
  cityKey,
  decodeXmlBytes,
  describeParseStats,
  foldStationName,
  makeCfrStationIndex,
  matchOfficialStops,
  parseMersTrenXml,
  parseTimeSeconds,
  pickTimetableResource,
  rowInAgency,
  secondsToHHMM,
  stopsFromElements,
  timetableYearLabel,
  trainNumbersFromLabel,
} from "../scripts/lib/cfr-mers-tren.mjs";
import { resolveTimetableSource, wantedTrainNumbers } from "../scripts/adapters/cfr.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ─── Fixture: the shape of the data.gov.ro "Mers tren" XML ──────────────────
// Attribute-only segments (ElementTrasa) from one station to the next; times
// in seconds since midnight; ASCII-folded station names; Windows-1250 header.
const seg = (secv, from, to, oraP, oraS, extra = "") =>
  `<ElementTrasa Secventa="${secv}" CodStaOrigine="${1000 + secv}" DenStaOrigine="${from}" CodStaDest="${1001 + secv}" DenStaDestinatie="${to}" OraP="${oraP}" OraS="${oraS}" ${extra}/>`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<XmlIf>
  <XmlMts>
    <Mt OperatorFeroviar="SNTFC CFR CALATORI SA">
      <Trenuri>
        <Tren Numar="1669" CategorieTren="IRN" Operator="SNTFC &quot;CFR Calatori&quot; SA">
          <Trase>
            <Trasa Tip="1">
              ${seg(1, "Bucuresti Nord", "Ploiesti Sud", 79200, 82200)}
              ${seg(2, "Ploiesti Sud", "Mizil", 82320, 84600)}
              ${seg(3, "Mizil", "Buzau", 84600, 86400)}
              ${seg(4, "Buzau", "Bacau", 86700, 97200)}
              ${seg(5, "Bacau", "Roman", 97500, 99900)}
              ${seg(6, "Roman", "Iasi", 100200, 106200)}
            </Trasa>
          </Trase>
        </Tren>
        <Tren Numar="472" CategorieTren="IC">
          <Trase>
            <Trasa Tip="1">
              ${seg(1, "Bucuresti Nord", "Brasov", 72000, 81000)}
              ${seg(2, "Brasov", "Sibiu", 81300, 90000)}
              ${seg(3, "Sibiu", "Arad", 90300, 105000)}
              ${seg(4, "Arad", "Curtici", 105300, 106800)}
            </Trasa>
          </Trase>
        </Tren>
        <Tren Numar="1954" CategorieTren="IRN">
          <Trase>
            <Trasa Tip="1">
              ${seg(1, "Suceava Nord", "Suceava", 68400, 68700)}
              ${seg(2, "Suceava", "Bacau", 69000, 76000)}
              ${seg(3, "Bacau", "Constanta", 76300, 96000)}
            </Trasa>
          </Trase>
        </Tren>
        <Tren Numar="8824" CategorieTren="R">
          <Trase>
            <Trasa Tip="1">
              ${seg(1, "Constanta", "Mangalia", 96600, 100200)}
            </Trasa>
          </Trase>
        </Tren>
        <Tren Numar="401" CategorieTren="IR">
          <Trase>
            <Trasa Tip="1">
              ${seg(1, "Sibiu", "Medias", 30000, 33000)}
            </Trasa>
          </Trase>
        </Tren>
      </Trenuri>
    </Mt>
  </XmlMts>
</XmlIf>`;

const BOT_STOPS = {
  a: { stop_name: "București Nord", stop_country: "RO", stop_lat: 44.4468, stop_lon: 26.0744 },
  b: { stop_name: "Ploiești Sud", stop_country: "RO", stop_lat: 44.9254, stop_lon: 26.0296 },
  c: { stop_name: "Buzău", stop_country: "RO", stop_lat: 45.15, stop_lon: 26.8333 },
  d: { stop_name: "Bacău", stop_country: "RO", stop_lat: 46.5638, stop_lon: 26.8946 },
  e: { stop_name: "Iași", stop_country: "RO", stop_lat: 47.1572, stop_lon: 27.6035 },
  f: { stop_name: "Roman", stop_country: "BG", stop_lat: 43.1545, stop_lon: 23.9215 },
  g: { stop_name: "Roman", stop_country: "RO", stop_lat: 46.9347, stop_lon: 26.9199 },
  h: { stop_name: "Brașov", stop_country: "RO", stop_lat: 45.6438, stop_lon: 25.5868 },
  i: { stop_name: "Sibiu", stop_country: "RO", stop_lat: 45.7998, stop_lon: 24.1623 },
  j: { stop_name: "Arad", stop_country: "RO", stop_lat: 46.1913, stop_lon: 21.3249 },
  k: { stop_name: "Curtici", stop_country: "RO", stop_lat: 46.3425, stop_lon: 21.2976 },
  l: { stop_name: "Szolnok", stop_country: "HU", stop_lat: 47.1798, stop_lon: 20.1758 },
  m: { stop_name: "Budapest Keleti", stop_country: "HU", stop_lat: 47.5006, stop_lon: 19.0843 },
  n: { stop_name: "Timişoara Nord", stop_country: "RO", stop_lat: 45.7509, stop_lon: 21.208 },
  o: { stop_name: "Timișoara Nord", stop_country: "RO", stop_lat: 45.7509, stop_lon: 21.208 },
  p: { stop_name: "Suceava Nord", stop_country: "RO", stop_lat: 47.6764, stop_lon: 26.2363 },
  q: { stop_name: "Suceava", stop_country: "RO", stop_lat: 47.6679, stop_lon: 26.2747 },
  r: { stop_name: "Constanța", stop_country: "RO", stop_lat: 44.1688, stop_lon: 28.6319 },
  s: { stop_name: "Mangalia", stop_country: "RO", stop_lat: 43.8229, stop_lon: 28.582 },
  t: { stop_name: "Mizil", stop_country: "RO", stop_lat: 44.9941, stop_lon: 26.4377 },
};

const VIEW_MAP = {
  23: {
    route_id: 23,
    agency_id: "CFR",
    trip_short_name_0: "IRN 1669",
    origin_trip_0: "București Nord",
    destination_trip_0: "Iași",
    via_0: "Ploiești Sud - Buzău",
    trip_short_name_1: "IRN 1668",
    origin_trip_1: "Iași",
    destination_trip_1: "București Nord",
    via_1: "Vaslui - Bârlad",
  },
  12: {
    route_id: 12,
    agency_id: "CFR",
    trip_short_name_0: "IC 472",
    origin_trip_0: "București Nord",
    destination_trip_0: "Budapest Keleti",
    via_0: "Ploiești Vest - Brașov - Sibiu - Arad - Curtici - Szolnok",
  },
  13: {
    route_id: 13,
    agency_id: "CFR",
    trip_short_name_1: "IRN 1954/R 8824",
    origin_trip_1: "Suceava Nord",
    destination_trip_1: "Mangalia",
    via_1: "Suceava - Bacău - Buzău - Constanța",
  },
  237: {
    route_id: 237,
    agency_id: "ES",
    trip_short_name_0: "401",
    origin_trip_0: "Milano Porta Garibaldi",
    destination_trip_0: "Bruxelles Midi",
  },
};

// ─── Parsing ────────────────────────────────────────────────────────────────

check("parseTimeSeconds / secondsToHHMM: seconds since midnight, HH:MM, next-day wrap", () => {
  assert.strictEqual(parseTimeSeconds("36000"), 36000);
  assert.strictEqual(parseTimeSeconds("10:00"), 36000);
  assert.strictEqual(parseTimeSeconds("10:00:30"), 36030);
  assert.strictEqual(parseTimeSeconds(""), null);
  assert.strictEqual(secondsToHHMM(79200), "22:00");
  assert.strictEqual(secondsToHHMM(90000), "01:00");
  assert.strictEqual(secondsToHHMM(null), null);
});

check("parseMersTrenXml: trains keyed by number with stop lists rebuilt from segments", () => {
  const { trains, stats } = parseMersTrenXml(XML);
  assert.strictEqual(stats.trains, 5);
  assert.strictEqual(stats.elements, 15);
  const [t] = trains.get("1669");
  assert.strictEqual(t.category, "IRN");
  assert.strictEqual(t.operator, 'SNTFC "CFR Calatori" SA', "entities decoded");
  assert.deepStrictEqual(
    t.stops.map((s) => s.name),
    ["Bucuresti Nord", "Ploiesti Sud", "Buzau", "Bacau", "Roman", "Iasi"],
    "Mizil (zero dwell) is a run-through, not a stop",
  );
  assert.strictEqual(t.stops[0].departure, 79200);
  assert.strictEqual(t.stops[0].arrival, null);
  assert.strictEqual(t.stops[1].arrival, 82200);
  assert.strictEqual(t.stops[1].departure, 82320);
  assert.strictEqual(t.stops[5].arrival, 106200);
  assert.strictEqual(t.stops[5].departure, null);
});

check("parseMersTrenXml: onlyNumbers keeps the file's other trains out of memory", () => {
  const { trains, stats } = parseMersTrenXml(XML, { onlyNumbers: ["472"] });
  assert.deepStrictEqual([...trains.keys()], ["472"]);
  assert.strictEqual(stats.trains, 5, "census still counts everything");
  assert.ok(describeParseStats(stats).includes("ElementTrasa"));
});

check("stopsFromElements: explicit stop-type markers decide when times give no dwell", () => {
  const stops = stopsFromElements([
    { seq: 1, from: "A", to: "B", departure: 0, arrival: 600, stopType: null },
    { seq: 2, from: "B", to: "C", departure: null, arrival: 1200, stopType: "F" },
    { seq: 3, from: "C", to: "D", departure: null, arrival: 1800, stopType: "N" },
  ]);
  assert.deepStrictEqual(stops.map((s) => s.name), ["A", "C", "D"]);
});

check("decodeXmlBytes honours the declared encoding", () => {
  const latin2 = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-2"?><Tren Numar="1" DenStaOrigine="', "latin1"),
    Buffer.from([0xb3]), // ł in ISO-8859-2
    Buffer.from('"/>', "latin1"),
  ]);
  assert.ok(decodeXmlBytes(latin2).includes("ł"));
  assert.ok(decodeXmlBytes(Buffer.from(XML, "utf8")).includes("Bucuresti"));
});

check("decodeXmlBytes unwraps gzip by its bytes, not by a filename", () => {
  // The committed fallback copy is gzipped and a downloaded one is not, and the
  // adapter hands over bytes either way — so the decoder tells them apart
  // itself, and the declared encoding must survive the round trip.
  const latin2 = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-2"?><Tren Numar="1" DenStaOrigine="', "latin1"),
    Buffer.from([0xb3]),
    Buffer.from('"/>', "latin1"),
  ]);
  assert.strictEqual(decodeXmlBytes(zlib.gzipSync(latin2)), decodeXmlBytes(latin2));
  assert.ok(decodeXmlBytes(zlib.gzipSync(latin2)).includes("ł"));

  const plain = Buffer.from(XML, "utf8");
  assert.strictEqual(decodeXmlBytes(zlib.gzipSync(plain)), decodeXmlBytes(plain));

  // A one-byte buffer must not be mistaken for a truncated gzip header.
  assert.strictEqual(decodeXmlBytes(Buffer.from([0x1f])), "\u001f");
});

// ─── Names ──────────────────────────────────────────────────────────────────

check("foldStationName: ASCII XML names equal the map's diacritic spellings", () => {
  assert.strictEqual(foldStationName("Bucuresti Nord"), foldStationName("București Nord"));
  assert.strictEqual(foldStationName("Timisoara Nord"), foldStationName("Timişoara Nord"));
  assert.strictEqual(foldStationName("Timişoara Nord"), foldStationName("Timișoara Nord"));
  assert.strictEqual(foldStationName("Cluj Napoca"), foldStationName("Cluj-Napoca"));
  assert.strictEqual(foldStationName("Vatra Dornei Bai"), foldStationName("Vatra Dornei Băi"));
  assert.strictEqual(foldStationName("Chisinau"), foldStationName("Chişinău"));
  assert.strictEqual(foldStationName("h. Posada"), "posada");
  assert.strictEqual(cityKey("Ploiesti Vest"), cityKey("Ploiești Sud"));
});

check("makeCfrStationIndex: canonical BoT spelling + coords, Romania beats a Bulgarian namesake", () => {
  const resolve = makeCfrStationIndex({
    botStops: BOT_STOPS,
    preferred: ["Timişoara Nord"],
    overrides: { "Roman": { lat: 46.9346624, lon: 26.9199022 } },
    catalog: { "Lokoshaza": { lat: 46.4322, lon: 21.2378 } },
  });
  assert.deepStrictEqual(resolve("Bucuresti Nord"), { name: "București Nord", lat: 44.4468, lon: 26.0744, known: true });
  const roman = resolve("Roman");
  assert.ok(roman.lat > 46, "Romania's Roman, not Bulgaria's");
  assert.strictEqual(resolve("Timisoara Nord").name, "Timişoara Nord", "the spelling BoT rows use wins among duplicates");
  assert.strictEqual(resolve("Lokoshaza").known, true, "allowlist catalog adds coordless official names");
  assert.deepStrictEqual(resolve("Nowhere Halt"), { name: "Nowhere Halt", lat: null, lon: null, known: false });
});

check("trainNumbersFromLabel / rowInAgency", () => {
  assert.deepStrictEqual(trainNumbersFromLabel("IRN 1954/R 8824"), ["1954", "8824"]);
  assert.deepStrictEqual(trainNumbersFromLabel("IRN / IC 78"), ["78"]);
  assert.deepStrictEqual(trainNumbersFromLabel("401"), ["401"]);
  assert.deepStrictEqual(trainNumbersFromLabel("R-E 4007/IRN 12642"), ["4007", "12642"]);
  assert.ok(rowInAgency({ agency_id: "CFR" }));
  assert.ok(rowInAgency({ agency_id: "TCDD/BDŽ/CFR" }));
  assert.ok(rowInAgency({ agency_id: "ÖBB", bot_agency_id: "CFR/MÁV/ÖBB" }), "joint operator BoT recorded");
  assert.ok(!rowInAgency({ agency_id: "CFM" }));
  assert.ok(!rowInAgency({ agency_id: "ES" }));
});

// ─── Matching ───────────────────────────────────────────────────────────────

const { trains: XML_TRAINS } = parseMersTrenXml(XML);

check("matchOfficialStops: full match on endpoints, diacritics ignored", () => {
  const m = matchOfficialStops(
    { origin: "București Nord", destination: "Iași", via: "Ploiești Sud - Buzău" },
    ["1669"],
    XML_TRAINS,
  );
  assert.strictEqual(m.coverage, "full");
  assert.strictEqual(m.stops.length, 6);
});

check("matchOfficialStops: through cars stitched at their junction in label order", () => {
  const m = matchOfficialStops(
    { origin: "Suceava Nord", destination: "Mangalia", via: "Suceava - Bacău - Buzău - Constanța" },
    ["1954", "8824"],
    XML_TRAINS,
  );
  assert.strictEqual(m.coverage, "full");
  assert.deepStrictEqual(
    m.stops.map((s) => s.name),
    ["Suceava Nord", "Suceava", "Bacau", "Constanta", "Mangalia"],
  );
  assert.strictEqual(m.stops[3].arrival, 96000, "junction keeps the incoming arrival…");
  assert.strictEqual(m.stops[3].departure, 96600, "…and the outgoing departure");
});

check("matchOfficialStops: an international train gets the Romanian stretch spliced into BoT's chain", () => {
  const m = matchOfficialStops(
    {
      origin: "București Nord",
      destination: "Budapest Keleti",
      via: "Ploiești Vest - Brașov - Sibiu - Arad - Curtici - Szolnok",
    },
    ["472"],
    XML_TRAINS,
  );
  assert.strictEqual(m.coverage, "partial");
  assert.deepStrictEqual(
    m.stops.map((s) => s.name),
    ["Bucuresti Nord", "Brasov", "Sibiu", "Arad", "Curtici", "Szolnok", "Budapest Keleti"],
  );
  assert.strictEqual(m.stops[5].departure, null, "BoT remainder carries no official times");
});

check("matchOfficialStops: a reused number on another corridor is rejected", () => {
  // The file's 401 is Sibiu–Mediaș; the row is Chișinău–București.
  assert.strictEqual(
    matchOfficialStops({ origin: "Chişinău", destination: "București Nord", via: "Ungheni - Iași" }, ["401"], XML_TRAINS),
    null,
  );
});

check("buildCfrTrains: keys are BoT's own labels, stops carry canonical names, coords and THH:MM times", () => {
  const resolveStation = makeCfrStationIndex({ botStops: BOT_STOPS });
  const { trains, report } = buildCfrTrains({
    xmlTrains: XML_TRAINS,
    viewMap: VIEW_MAP,
    resolveStation,
    today: "2026-09-03",
  });
  assert.deepStrictEqual(Object.keys(trains).sort(), ["IC 472", "IRN 1669", "IRN 1954/R 8824"]);
  assert.deepStrictEqual(report.unmatched, ["IRN 1668"], "the file has no 1668; the ES row (401) is out of scope");
  const t = trains["IRN 1669"];
  assert.strictEqual(t.agency_id, "CFR");
  assert.strictEqual(t.coverage, "full");
  assert.deepStrictEqual(
    t.stations.map((s) => s.name),
    ["București Nord", "Ploiești Sud", "Buzău", "Bacău", "Roman", "Iași"],
  );
  assert.strictEqual(t.stations[0].departure, "2026-09-03T22:00:00");
  assert.strictEqual(t.stations[5].arrival, "2026-09-03T05:30:00");
  assert.deepStrictEqual(t.stations[0].location, { latitude: 44.4468, longitude: 26.0744 });
  assert.strictEqual(trains["IC 472"].coverage, "partial");
  assert.strictEqual(trains["IC 472"].stations.at(-1).name, "Budapest Keleti");
  assert.strictEqual(t.polyline, null, "geometry is the adapter's job");
});

check("buildCfrTrains: extras from the allowlist, validated on endpoints when given", () => {
  const resolveStation = makeCfrStationIndex({ botStops: BOT_STOPS });
  const { trains, report } = buildCfrTrains({
    xmlTrains: XML_TRAINS,
    viewMap: {},
    resolveStation,
    today: "2026-09-03",
    extraTrains: [
      { label: "IR 401", origin: "Sibiu", destination: "Mediaș" },
      { label: "IR 401 wrong", numbers: ["401"], origin: "Sibiu", destination: "Cluj-Napoca" },
      { label: "IRN 1669", frequency: "Daily" },
    ],
  });
  assert.deepStrictEqual(Object.keys(trains).sort(), ["IRN 1669"]);
  assert.strictEqual(trains["IRN 1669"].frequency, "Daily");
  assert.ok(report.skippedShort.includes("IR 401"), "a 2-stop list is worse than nothing");
  assert.ok(report.unmatched.includes("IR 401 wrong"));
});

check("wantedTrainNumbers: every CFR row label's numbers plus allowlist extras, nothing else", () => {
  const wanted = wantedTrainNumbers(VIEW_MAP, [{ label: "IR 1621" }], "CFR");
  assert.deepStrictEqual([...wanted].sort(), ["1621", "1668", "1669", "1954", "472", "8824"]);
});

// ─── CKAN resource selection ────────────────────────────────────────────────

check("timetableYearLabel flips on the second Sunday of December", () => {
  assert.strictEqual(timetableYearLabel(new Date("2026-09-03T00:00:00Z")), "2025-2026");
  assert.strictEqual(timetableYearLabel(new Date("2026-12-12T00:00:00Z")), "2025-2026");
  assert.strictEqual(timetableYearLabel(new Date("2026-12-13T00:00:00Z")), "2026-2027");
});

check("pickTimetableResource: current year's XML over last year's and over PDFs", () => {
  const pkg = {
    result: {
      resources: [
        { name: "Mers tren 2024-2025", format: "XML", url: "https://data.gov.ro/x/2024-2025.xml", last_modified: "2024-12-01T00:00:00" },
        { name: "Ghid", format: "PDF", url: "https://data.gov.ro/x/ghid.pdf", last_modified: "2026-01-01T00:00:00" },
        { name: "Mers tren 2025-2026", format: "XML", url: "https://data.gov.ro/x/2025-2026.xml", last_modified: "2025-12-10T00:00:00" },
      ],
    },
  };
  const r = pickTimetableResource(pkg, { now: new Date("2026-09-03T00:00:00Z") });
  assert.strictEqual(r.url, "https://data.gov.ro/x/2025-2026.xml");
  // No year in any name → newest wins; a zip is acceptable.
  const r2 = pickTimetableResource(
    { result: { resources: [
      { name: "mt", format: "ZIP", url: "https://x/a.zip", last_modified: "2026-02-01" },
      { name: "mt", format: "XML", url: "https://x/b.xml", last_modified: "2025-02-01" },
    ] } },
    { now: new Date("2026-09-03T00:00:00Z") },
  );
  assert.strictEqual(r2.url, "https://x/b.xml", "XML preferred over ZIP when neither names the year");
  assert.strictEqual(pickTimetableResource({ result: { resources: [{ format: "PDF", url: "https://x/a.pdf" }] } }), null);
});

await checkAsync("pickTimetableResource: the real data.gov.ro package, captured 2026-09", async () => {
  // Live data revealed something no synthetic fixture had: the publisher set
  // the current resource's format to ".xml" (leading dot) while every older one
  // says "XML". The +10 format bonus only counts "XML", so the pick survives
  // solely because isXml also tests the URL extension — pinned here so a future
  // tidy-up of that check cannot silently promote last year's timetable.
  const pkg = JSON.parse(
    await fs.readFile(new URL("./fixtures/cfr/package-show-2026-09.json", import.meta.url), "utf8"),
  );

  const current = pickTimetableResource(pkg, { now: new Date("2026-09-10T12:00:00Z") });
  assert.strictEqual(current.name, "Mers tren - SNTFC 2025-2026");
  assert.strictEqual(current.format, "XML", '".xml" must normalise to XML');
  assert.match(current.url, /trenuri-2025-2026_sntfc\.xml$/);

  // The day before the timetable change still belongs to the running year.
  assert.strictEqual(
    pickTimetableResource(pkg, { now: new Date("2026-12-12T12:00:00Z") }).name,
    "Mers tren - SNTFC 2025-2026",
  );
  // And on the change itself the label flips to 2026-2027 — but that file is not
  // published yet, so the newest one must be kept rather than nothing returned.
  assert.strictEqual(timetableYearLabel(new Date("2026-12-13T12:00:00Z")), "2026-2027");
  assert.strictEqual(
    pickTimetableResource(pkg, { now: new Date("2026-12-13T12:00:00Z") }).name,
    "Mers tren - SNTFC 2025-2026",
  );
});

// ─── Where tonight's timetable comes from ───────────────────────────────────

const RESOURCE = { name: "Mers tren 2026", format: "XML", url: "https://x/2026.xml", lastModified: "2026-01-02" };
const sourceArgs = (over = {}) => ({
  entry: { id: "cfr", output: "cfr-trains.json" },
  ctx: { rootDir: "/repo", errors: [] },
  baseUrl: "https://data.gov.ro/api/3/action/package_show?id=x",
  localTimetable: "data/sources/cfr-mers-tren.xml.gz",
  workDir: "/repo/gtfs-data/cfr-unpacked",
  env: {},
  fetchPackage: async () => ({ result: { resources: [RESOURCE] } }),
  downloadTimetable: async () => "/repo/gtfs-data/cfr-unpacked/mers-tren.xml",
  exists: () => true,
  ...over,
});

await checkAsync("resolveTimetableSource: the live resource wins when it can be reached", async () => {
  const args = sourceArgs();
  const got = await resolveTimetableSource(args);
  assert.strictEqual(got.origin, RESOURCE.url);
  assert.strictEqual(got.resource.name, RESOURCE.name);
  // A reachable remote must not report a failure, even with a copy sitting there.
  assert.deepStrictEqual(args.ctx.errors, []);
});

await checkAsync("resolveTimetableSource: an unreachable remote falls back to the committed copy", async () => {
  // The real failure: the connection is dropped, so undici reports its generic
  // "fetch failed" with the reason in err.cause.
  const dropped = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ETIMEDOUT 85.120.75.35:443"), { code: "ETIMEDOUT" }),
  });
  const args = sourceArgs({ fetchPackage: async () => { throw dropped; } });
  const got = await resolveTimetableSource(args);
  assert.strictEqual(got.origin, "data/sources/cfr-mers-tren.xml.gz");
  assert.strictEqual(got.xmlPath, "/repo/data/sources/cfr-mers-tren.xml.gz");
  assert.strictEqual(got.resource, null);
  // Falling back is still a reported failure, or the run would read as clean
  // while the official endpoint is unreachable.
  assert.strictEqual(args.ctx.errors.length, 1);
  assert.strictEqual(args.ctx.errors[0].source, "cfr");
  assert.match(args.ctx.errors[0].error, /ETIMEDOUT/);
  assert.match(args.ctx.errors[0].error, /used committed data\/sources\/cfr-mers-tren\.xml\.gz/);
});

await checkAsync("resolveTimetableSource: with no committed copy the remote failure still throws", async () => {
  const boom = new Error("HTTP 503");
  await assert.rejects(
    () => resolveTimetableSource(sourceArgs({ fetchPackage: async () => { throw boom; }, exists: () => false })),
    /HTTP 503/,
  );
  await assert.rejects(
    () => resolveTimetableSource(sourceArgs({ fetchPackage: async () => { throw boom; }, localTimetable: null })),
    /HTTP 503/,
  );
});

await checkAsync("resolveTimetableSource: a package with no usable resource falls back too", async () => {
  const args = sourceArgs({ fetchPackage: async () => ({ result: { resources: [{ name: "guide", format: "PDF" }] } }) });
  const got = await resolveTimetableSource(args);
  assert.strictEqual(got.origin, "data/sources/cfr-mers-tren.xml.gz");
  assert.match(args.ctx.errors[0].error, /no XML\/ZIP timetable resource/);
});

await checkAsync("resolveTimetableSource: CFR_XML_PATH overrides both", async () => {
  let fetched = false;
  const got = await resolveTimetableSource(
    sourceArgs({ env: { CFR_XML_PATH: "tmp/mt.xml" }, fetchPackage: async () => { fetched = true; return {}; } }),
  );
  assert.strictEqual(got.xmlPath, "/repo/tmp/mt.xml");
  assert.match(got.origin, /CFR_XML_PATH=tmp\/mt\.xml/);
  assert.strictEqual(fetched, false, "the remote must not be touched when the override is set");
});

console.log(`\n[verify-cfr] ${passed} checks passed`);
