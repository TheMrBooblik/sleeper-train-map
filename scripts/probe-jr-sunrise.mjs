// scripts/probe-jr-sunrise.mjs
// What the jr-sunrise adapter sees on JR West's site, printed to the job log.
//
// The dev sandbox cannot reach JR's hosts, so this is how the parsers in
// scripts/lib/jr-sunrise.mjs are checked against the live documents. It reads
// exactly what the nightly adapter reads — the registry entry's guide pages and
// timetable PDF — and prints:
//
//   - per guide page: HTTP status, the berth charges read, and every timetable
//     PDF it links, flagging one that is not params.timetablePdf (JR renaming
//     the file at a timetable change is how the source would go stale);
//   - the PDF: size and Last-Modified, its text as positioned lines, and for
//     every train whether a column validates, with the stops it read.
//
// The guide pages' text comes LAST and capped, so the tail of the log is
// always the raw material for fixing a parser.
//
// Read-only: GET/HEAD requests only. Snapshots go to [outputDir] for the artifact.
// Run: node scripts/probe-jr-sunrise.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { loadRegistry } from "./lib/registry.mjs";
import { fetchPage, fetchPdf } from "./adapters/jr-sunrise.mjs";
import { pdfLines } from "./lib/pdf-lines.mjs";
import {
  extractLinks,
  htmlSegments,
  makeStationMatcher,
  parseRoomCharges,
  pdfColumns,
  timetablesFromPdf,
} from "./lib/jr-sunrise.mjs";

const outDir = process.argv[2] ?? null;
const MAX_TEXT_LOG = 12_000;
const MAX_PDF_LINES = 300;

const entry = loadRegistry().find((e) => e.id === "jr-sunrise");
if (!entry) {
  console.error("no jr-sunrise registry entry");
  process.exit(1);
}
const params = entry.params ?? {};
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), params.configPath), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const matchStation = makeStationMatcher(config.stations);

const slug = (url) => url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").slice(0, 120);
function save(name, data) {
  if (!outDir || !data) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), data);
}

console.log(`# JR Sunrise probe — ${today}\n`);

console.log("## Guide pages");
const dumps = [];
for (const url of params.guidePages ?? []) {
  const page = await fetchPage(url);
  save(`${slug(url)}.html`, page.html);
  console.log(`- ${url}\n  status ${page.status}${page.error ? ` (${page.error})` : ""}, ${page.html?.length ?? 0} chars`);
  if (!page.html) continue;
  console.log(`  berth charges read: ${JSON.stringify(parseRoomCharges(page.html))}`);
  const pdfs = extractLinks(page.html, url).filter((l) => /\.pdf(?:\?|$)/i.test(l.href));
  for (const l of pdfs) {
    const mark =
      l.href === params.timetablePdf ? "= params.timetablePdf" : /jikoku/i.test(l.href) ? "≠ params.timetablePdf — RENAMED?" : "";
    console.log(`  links PDF: ${l.text.slice(0, 40)} → ${l.href} ${mark}`);
  }
  dumps.push([url, page.html]);
}

console.log(`\n## Timetable PDF — ${params.timetablePdf}`);
try {
  const head = await fetch(params.timetablePdf, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  console.log(
    `HEAD ${head.status}, ${head.headers.get("content-length") ?? "?"} bytes, modified ${head.headers.get("last-modified") ?? "?"}`,
  );
} catch (err) {
  console.log(`HEAD failed: ${err.message}`);
}
const pdf = await fetchPdf(params.timetablePdf);
if (!pdf.bytes) {
  console.log(`no PDF: ${pdf.error}`);
} else {
  save("jikokuhyo.pdf", pdf.bytes);
  try {
    const pages = await pdfLines(pdf.bytes);
    const columns = pdfColumns(pages, matchStation);
    console.log(
      `${pdf.bytes.length} bytes, ${pages.length} page(s), ${columns.length} timetable column(s): ` +
        columns.map((c) => `${c.header}@x${c.x} (${c.records.length} timed stops)`).join(", "),
    );
    const { timetables, problems } = timetablesFromPdf(pages, config, matchStation);
    for (const train of config.trains) {
      const got = timetables[train.lineName];
      console.log(
        got
          ? `  ${train.lineName}: VALIDATES (column ${got.column}) — ${got.stops.map((s) => `${s.station} ${s.arrival ?? ""}/${s.departure ?? ""}`).join(", ")}`
          : `  ${train.lineName}: no — ${problems[train.lineName].join(" | ")}`,
      );
    }
    for (const [i, lines] of pages.entries()) {
      console.log(`\n### page ${i + 1} (${lines.length} lines)`);
      for (const line of lines.slice(0, MAX_PDF_LINES)) {
        console.log(`  y${String(line.y).padStart(4)} | ${line.cells.map((c) => `${c.x}:${c.text}`).join("  ")}`);
      }
    }
  } catch (err) {
    console.log(`could not read the PDF: ${err.message}`);
  }
}

console.log("\n## Guide page text (capped)");
for (const [url, html] of dumps) {
  const text = htmlSegments(html).join(" | ");
  console.log(`\n### ${url}\n${text.slice(0, MAX_TEXT_LOG)}${text.length > MAX_TEXT_LOG ? " …" : ""}`);
}
