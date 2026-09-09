// scripts/probe-cfr.mjs
// Reconnaissance for the CFR Călători open-data timetable (data.gov.ro). The
// dev sandbox has no egress to data.gov.ro, so this runs from CI ("Probe CFR
// source" workflow) where egress is open. Read-only GETs.
//
// The job LOG is the delivery channel: it prints the CKAN resource list, the
// resource the adapter would pick, the parsed file's tag/attribute census
// (which is what scripts/lib/cfr-mers-tren.mjs FIELDS must agree with), and
// one sample train per Back-on-Track CFR label — full stop list with times —
// so a field rename or a stop-detection mistake is visible without downloading
// anything. A trimmed sample of the raw XML is saved as an artifact too.
//
// Run: node scripts/probe-cfr.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadFile } from "./lib/gtfs.mjs";
import { describeError } from "./lib/describe-error.mjs";
import { reportReachability } from "./lib/probe-reachability.mjs";
import {
  buildCfrTrains,
  decodeXmlBytes,
  describeParseStats,
  makeCfrStationIndex,
  parseMersTrenXml,
  pickTimetableResource,
  secondsToHHMM,
} from "./lib/cfr-mers-tren.mjs";
import { wantedTrainNumbers } from "./adapters/cfr.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PACKAGE_SHOW =
  "https://data.gov.ro/api/3/action/package_show?id=mers-tren-sntfc-cfr-calatori-s-a";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

const outDir = process.argv[2] ?? null;
const save = (name, body) => {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), body);
};
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

// Before the timetable, the question the nightly log could never answer: is the
// host reachable, and if not, at which layer? Six "fetch failed" nights said
// nothing; each layer has a different fix. See scripts/lib/probe-reachability.mjs.
await reportReachability(new URL(PACKAGE_SHOW).hostname);

// The GET itself, reported rather than thrown: an unhandled rejection here
// prints "fetch failed" and the probe delivers nothing.
let pkgRes;
try {
  pkgRes = await fetch(PACKAGE_SHOW, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
} catch (err) {
  console.error(`\npackage_show → FAILED: ${describeError(err)}`);
  console.error(
    "The triage above says which layer broke. DNS → resolver/blocklist; TLS ok but " +
    "fetch failed → HTTP-layer block (WAF/User-Agent/geo); IPv6 fails while IPv4 " +
    "succeeds → dual-stack, pin the family in the adapter.",
  );
  process.exit(1);
}
console.log(`\npackage_show → HTTP ${pkgRes.status}`);
if (!pkgRes.ok) {
  console.error(`body: ${(await pkgRes.text()).slice(0, 600)}`);
  process.exit(1);
}
const pkg = await pkgRes.json();
save("package_show.json", JSON.stringify(pkg, null, 2));
console.log("\n=== resources ===");
for (const r of pkg?.result?.resources ?? []) {
  console.log(`- ${r.name} [${r.format}] modified=${r.last_modified ?? r.created ?? "?"} size=${r.size ?? "?"}\n    ${r.url}`);
}
const resource = pickTimetableResource(pkg);
console.log("\n=== picked ===\n", resource);
if (!resource) process.exit(0);

const work = path.join(ROOT, "gtfs-data", "cfr-probe-unpacked"); // gitignored (gtfs-data/*-unpacked/)
fs.mkdirSync(work, { recursive: true });
const file = path.join(work, resource.format === "ZIP" ? "mt.zip" : "mt.xml");
await downloadFile(resource.url, file);
let xmlPath = file;
if (resource.format === "ZIP") {
  const { execSync } = await import("node:child_process");
  execSync(`unzip -o -q "${file}" -d "${work}/unpacked"`, { stdio: "inherit" });
  xmlPath = fs
    .readdirSync(`${work}/unpacked`, { recursive: true })
    .map(String)
    .filter((f) => f.toLowerCase().endsWith(".xml"))
    .map((f) => path.join(`${work}/unpacked`, f))[0];
}
const bytes = fs.readFileSync(xmlPath);
console.log(`\ndownloaded ${bytes.length} bytes → ${xmlPath}`);
const xml = decodeXmlBytes(bytes);
console.log("\n=== head (2 KB) ===\n" + xml.slice(0, 2000));
save("mers-tren-head.xml", xml.slice(0, 200_000));

const { trains, stats } = parseMersTrenXml(xml);
console.log("\n=== census ===\n" + describeParseStats(stats));
console.log("attribute names per tag:");
for (const [tag, attrs] of Object.entries(stats.attrs)) console.log(`  ${tag}: ${Object.keys(attrs).join(", ")}`);
console.log(`\nparsed ${trains.size} distinct train number(s)`);

// What the adapter would do with tonight's Back-on-Track rows.
const viewMap = readJson("public/data/scraped/backontrack-view_ontd_map.json")?.data ?? {};
const stops = readJson("public/data/scraped/backontrack-stops.json")?.data ?? {};
const config = readJson("data/sources/cfr-sleepers.json");
const wanted = wantedTrainNumbers(viewMap, config.trains ?? [], "CFR");
console.log(`\nwanted numbers (${wanted.size}): ${[...wanted].sort().join(", ")}`);
console.log(`present in file: ${[...wanted].filter((n) => trains.has(n)).sort().join(", ") || "none"}`);
console.log(`missing from file: ${[...wanted].filter((n) => !trains.has(n)).sort().join(", ") || "none"}`);

const resolveStation = makeCfrStationIndex({ botStops: stops, catalog: config.stations ?? {} });
const built = buildCfrTrains({
  xmlTrains: trains,
  viewMap,
  resolveStation,
  today: new Date().toISOString().slice(0, 10),
  extraTrains: config.trains ?? [],
});
console.log(`\n=== adapter result ===\nfull: ${built.report.matched.join(", ") || "none"}\npartial: ${built.report.partial.join(", ") || "none"}\nunmatched: ${built.report.unmatched.join(", ") || "none"}\nunknown stations: ${built.report.unknownStations.join(", ") || "none"}`);
for (const [label, t] of Object.entries(built.trains)) {
  console.log(`\n--- ${label} (${t.coverage}, numbers ${t.officialNumbers.join("+")}) ---`);
  for (const s of t.stations) {
    const arr = s.arrival?.match(/T(\d{2}:\d{2})/)?.[1] ?? "  -  ";
    const dep = s.departure?.match(/T(\d{2}:\d{2})/)?.[1] ?? "  -  ";
    console.log(`  ${arr} ${dep}  ${s.name}${s.location ? "" : "   (no coords)"}`);
  }
}
// Raw view of one wanted train so stop detection can be checked by eye.
const sampleNumber = [...wanted].find((n) => trains.has(n));
if (sampleNumber) {
  console.log(`\n=== raw stops of ${sampleNumber} (every segment end, dwell in s) ===`);
  for (const s of trains.get(sampleNumber)[0].stops) {
    console.log(`  ${secondsToHHMM(s.arrival) ?? "  -  "} ${secondsToHHMM(s.departure) ?? "  -  "}  ${s.name}`);
  }
}
save("adapter-result.json", JSON.stringify(built, null, 2));
