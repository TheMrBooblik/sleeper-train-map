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
  extractLinks,
  extractStopRecords,
  htmlSegments,
  makeStationMatcher,
  matchTrainInRecords,
  pageTrainNumbers,
  parseRoomCharges,
  timetableFromPage,
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

// ─── Where JR links the Sunrise's own train pages ────────────────────────────
// The seeded ids were wrong trains (a Nagoya local, the Yamanote line) and the
// guide page links no train page, so this walks JR West's links outward from
// the guide — station pages, station timetables, the timetable PDF — and
// reports every link that names a Sunrise, so the adapter can be pointed at
// the place JR itself keeps them. Bounded: MAX_CRAWL fetches, same spacing as
// the adapter, JR West's hosts only.
const MAX_CRAWL = 30;
const MAX_DEPTH = 3;
const stationNames = new Set(config.stations.flatMap((s) => s.aliases ?? []));
const isJrWest = (href) => /^https?:\/\/(?:www\.|timetable\.)?jr-odekake\.net\//.test(href);
const SUNRISE = /サンライズ|sunrise/i;
const worthFollowing = ({ href, text }) =>
  isJrWest(href) &&
  !/\.(?:pdf|jpe?g|png|gif|css|js)(?:\?|$)/i.test(href) &&
  (/station-timetable|train-timetable|\/eki\//i.test(href) ||
    /時刻表|駅情報|timetable/i.test(text) ||
    stationNames.has(text.replace(/駅$/, "")));

console.log("\n## Link walk from the guide pages");
const seen = new Set();
const queue = (params.guidePages ?? []).map((url) => ({ url, depth: 0, via: "guide" }));
const sunriseTrainLinks = new Map();
const pdfs = new Map();
let fetched = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (queue.length && fetched < MAX_CRAWL) {
  const { url, depth, via } = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);
  const page = await fetchPage(url);
  fetched++;
  await sleep(800);
  save(url, page.html);
  const links = extractLinks(page.html, url);
  const named = links.filter((l) => SUNRISE.test(l.text) || SUNRISE.test(l.href));
  console.log(`\n- [d${depth}] ${url} (via ${via}) → ${page.status}${page.error ? ` ${page.error}` : ""}, ${links.length} links, ${named.length} naming a Sunrise`);
  for (const l of links) {
    if (/\.pdf(?:\?|$)/i.test(l.href)) pdfs.set(l.href, l.text);
    if (/train-timetable\/\d+/.test(l.href) && (SUNRISE.test(l.text) || /寝台/.test(l.text))) {
      sunriseTrainLinks.set(l.href, { text: l.text, from: url });
    }
  }
  for (const l of named.slice(0, 15)) console.log(`    sunrise: ${l.text.slice(0, 60)} → ${l.href}`);
  const follow = depth < MAX_DEPTH ? links.filter(worthFollowing) : [];
  for (const l of follow.slice(0, 25)) {
    if (!seen.has(l.href)) queue.push({ url: l.href, depth: depth + 1, via: l.text.slice(0, 30) || "link" });
  }
  if (follow.length) console.log(`    follows ${Math.min(follow.length, 25)}: ${follow.slice(0, 8).map((l) => `${l.text.slice(0, 16)}→${l.href.replace(/^https?:\/\//, "")}`).join(" ; ")}`);
}
console.log(`\n${fetched} page(s) fetched, ${queue.length} left unvisited.`);

console.log("\n## PDFs linked");
for (const [href, text] of pdfs) {
  try {
    const res = await fetch(href, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    console.log(`- ${text.slice(0, 40)} → ${href} — ${res.status} ${res.headers.get("content-type")} ${res.headers.get("content-length") ?? "?"} bytes, modified ${res.headers.get("last-modified") ?? "?"}`);
  } catch (err) {
    console.log(`- ${text.slice(0, 40)} → ${href} — ${err.message}`);
  }
  await sleep(500);
}

console.log(`\n## Train pages linked as a Sunrise (${sunriseTrainLinks.size})`);
for (const [href, { text, from }] of [...sunriseTrainLinks].slice(0, 12)) {
  const page = await fetchPage(href);
  await sleep(800);
  save(href, page.html);
  const numbers = pageTrainNumbers(page.html);
  console.log(`\n### ${text.slice(0, 50)} → ${href}\n  linked from ${from}; status ${page.status}; 列車番号 ${JSON.stringify(numbers)}`);
  if (!page.html) continue;
  for (const train of config.trains) {
    const result = timetableFromPage(page.html, train, matchStation);
    console.log(`  ${train.lineName}: ${result.stops ? `VALIDATES — ${result.stops.map((s) => `${s.station} ${s.arrival ?? ""}/${s.departure ?? ""}`).join(", ")}` : `no — ${result.problems.slice(0, 3).join("; ")}`}`);
  }
}

console.log("\n## Page text (capped)");
for (const [url, html] of dumps) {
  const text = htmlSegments(html).join(" | ");
  console.log(`\n### ${url}\n${text.slice(0, MAX_TEXT_LOG)}${text.length > MAX_TEXT_LOG ? " …" : ""}`);
}
