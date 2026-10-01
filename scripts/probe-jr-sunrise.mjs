// scripts/probe-jr-sunrise.mjs
// What the jr-sunrise adapter sees on JR West's pages, printed to the job log.
//
// The dev sandbox cannot reach JR's hosts, so the parsers in
// scripts/lib/jr-sunrise.mjs were written without seeing the live markup; this
// is how that gets checked before (and after) a merge. It fetches exactly what
// the nightly adapter fetches — the registry entry's own guide pages, seed ids
// and URL template — and prints, per page: the HTTP status and charset, the
// timetable ids it links to, the stop records the parser extracted, and for
// every train whether the page validates and if not, why. The digest comes
// first and a capped text dump of each page LAST, so the tail of the log is
// always the raw material for fixing a parser.
//
// Read-only: GET requests only. Snapshots go to [outputDir] for the artifact.
// Run: node scripts/probe-jr-sunrise.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { loadRegistry } from "./lib/registry.mjs";
import { fetchPage } from "./adapters/jr-sunrise.mjs";
import {
  datePlusDays,
  discoverTimetableIds,
  expandUrlTemplate,
  extractStopRecords,
  htmlSegments,
  makeStationMatcher,
  matchTrainInRecords,
  parseRoomCharges,
  validateScrapedStops,
} from "./lib/jr-sunrise.mjs";

const outDir = process.argv[2] ?? null;
const MAX_TEXT_LOG = 12_000;

const entry = loadRegistry().find((e) => e.id === "jr-sunrise");
if (!entry) {
  console.error("no jr-sunrise registry entry");
  process.exit(1);
}
const params = entry.params ?? {};
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), params.configPath), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const travelDate = datePlusDays(today, params.dateOffsetDays ?? 3);
const matchStation = makeStationMatcher(config.stations);

const slug = (url) => url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").slice(0, 120);
function save(url, html) {
  if (!outDir || !html) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug(url)}.html`), html);
}

const dumps = [];

console.log(`# JR Sunrise probe — ${today}, timetable date ${travelDate}\n`);

console.log("## Guide pages");
const guides = [];
for (const url of params.guidePages ?? []) {
  const page = await fetchPage(url);
  guides.push(page);
  save(url, page.html);
  console.log(`- ${url}\n  status ${page.status}${page.error ? ` (${page.error})` : ""}, ${page.html?.length ?? 0} chars`);
  if (!page.html) continue;
  console.log(`  links to timetable ids: ${JSON.stringify(discoverTimetableIds(page.html))}`);
  console.log(`  berth charges read: ${JSON.stringify(parseRoomCharges(page.html))}`);
  dumps.push([url, page.html]);
}

const ids = [...new Set([...(params.seedTimetableIds ?? []), ...guides.flatMap((g) => discoverTimetableIds(g.html))])];
console.log(`\n## Timetable pages (${ids.length})`);
for (const id of ids) {
  const url = expandUrlTemplate(params.timetableUrlTemplate, { id, date: travelDate });
  const page = await fetchPage(url);
  save(url, page.html);
  console.log(`\n### ${url}\nstatus ${page.status}${page.error ? ` (${page.error})` : ""}, ${page.html?.length ?? 0} chars`);
  if (!page.html) continue;
  const records = extractStopRecords(page.html, matchStation);
  console.log(`stop records (${records.length}):`);
  for (const r of records.slice(0, 40)) {
    console.log(`  ${r.station.padEnd(18)} ${r.pass ? "passes " : ""}${r.times.map((t) => `${t.time}${t.label ? `(${t.label})` : ""}`).join(" ")}`);
  }
  for (const train of config.trains) {
    const { stops, problems } = matchTrainInRecords(records, train);
    const invalid = problems.length ? problems : validateScrapedStops(stops, train);
    console.log(`  ${train.lineName}: ${invalid.length ? `no — ${invalid.slice(0, 4).join("; ")}` : "VALIDATES"}`);
  }
  dumps.push([url, page.html]);
}

console.log("\n## Page text (capped)");
for (const [url, html] of dumps) {
  const text = htmlSegments(html).join(" | ");
  console.log(`\n### ${url}\n${text.slice(0, MAX_TEXT_LOG)}${text.length > MAX_TEXT_LOG ? " …" : ""}`);
}
