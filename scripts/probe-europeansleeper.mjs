// scripts/probe-europeansleeper.mjs
// Reconnaissance for the European Sleeper timetable adapter. The dev sandbox
// has no egress to europeansleeper.eu, so this runs from CI ("Probe European
// Sleeper source" workflow) where egress is open.
//
// The workflow artifact is not reachable from the sandbox either, so the job
// LOG is the delivery channel: this prints a structural digest first and then
// the timetable payload itself, capped, with the payload LAST so a tail of the
// log still carries it. Snapshots are also saved as an artifact for anyone who
// can download them.
//
// Read-only: GET requests with a descriptive User-Agent, nothing else.
// Run: node scripts/probe-europeansleeper.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";

const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://pingwi.com)";
const TARGETS = [
  "https://www.europeansleeper.eu/timetable",
  "https://www.europeansleeper.eu/en/timetable",
  "https://www.europeansleeper.eu/nl/dienstregeling",
];
const TRAIN_NUMBERS = ["400", "401", "452", "453", "454", "455", "474", "475"];
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LOG = 40_000;
const MAX_JSON_LOG = 30_000;

const outDir = process.argv[2] ?? null;

const slug = (url) =>
  url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").replace(/_+$/, "");

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), body.slice(0, MAX_SNAPSHOT_BYTES));
}

async function get(url, accept = "text/html,application/xhtml+xml") {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      redirect: "follow",
    });
    return { res, body: await res.text() };
  } catch (err) {
    return { error: err.message };
  }
}

/** Visible text of an HTML fragment, with block boundaries kept as newlines. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/td|\/th)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** How the page ships its data, so we know what to parse. */
function detectShape(body) {
  const shapes = [];
  const next = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (next) shapes.push({ kind: "__NEXT_DATA__", payload: next[1] });
  const nuxt = body.match(/window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/);
  if (nuxt) shapes.push({ kind: "__NUXT__", payload: nuxt[1] });
  const flight = [...body.matchAll(/self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g)];
  if (flight.length) shapes.push({ kind: "next-flight", payload: flight.map((m) => m[1]).join("\n") });
  const apollo = body.match(/window\.__APOLLO_STATE__\s*=\s*([\s\S]*?)<\/script>/);
  if (apollo) shapes.push({ kind: "__APOLLO_STATE__", payload: apollo[1] });
  const ldjson = [...body.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  if (ldjson.length) shapes.push({ kind: "ld+json", payload: ldjson.map((m) => m[1]).join("\n") });
  return shapes;
}

/** Slices of the document most likely to hold the timetable. */
function candidateRegions(body) {
  const regions = [];
  for (const m of body.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    regions.push({ kind: "table", html: m[0] });
  }
  // Sections whose text is dense in HH:MM — the timetable, whatever it is built from.
  for (const m of body.matchAll(/<(section|main|article)[\s\S]*?<\/\1>/gi)) {
    const text = visibleText(m[0]);
    const times = (text.match(/\b\d{1,2}[:.]\d{2}\b/g) ?? []).length;
    if (times >= 4) regions.push({ kind: `${m[1]} (${times} times)`, html: m[0] });
  }
  return regions;
}

function digest(url, res, body) {
  console.log(`\n━━━━━━━━━━ ${url}`);
  console.log(`  status ${res.status} | ${res.headers.get("content-type")} | ${body.length} bytes`);
  console.log(`  server ${res.headers.get("server") ?? "-"} | x-powered-by ${res.headers.get("x-powered-by") ?? "-"}`);

  const shapes = detectShape(body);
  console.log(`  data shapes: ${shapes.length ? shapes.map((s) => `${s.kind} (${s.payload.length}b)`).join(", ") : "none — plain server-rendered HTML"}`);
  console.log(`  <table> count: ${(body.match(/<table/gi) ?? []).length}`);
  const times = (body.match(/\b\d{1,2}[:.]\d{2}\b/g) ?? []).length;
  console.log(`  HH:MM-like strings in source: ${times}`);
  const present = TRAIN_NUMBERS.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
  console.log(`  train numbers present: ${present.join(", ") || "(none)"}`);
  const apiPaths = [...new Set((body.match(/["'](\/(?:api|_next\/data)\/[^"'\s]{1,140})["']/g) ?? []))];
  if (apiPaths.length) console.log(`  api-ish paths: ${apiPaths.slice(0, 12).join(" ")}`);

  return shapes;
}

const collected = [];

for (const url of TARGETS) {
  const { res, body, error } = await get(url);
  if (error) {
    console.log(`\n━━━━━━━━━━ ${url}\n  FAILED: ${error}`);
    continue;
  }
  if (!res.ok) {
    console.log(`\n━━━━━━━━━━ ${url}\n  status ${res.status} — skipped`);
    continue;
  }
  save(`${slug(url)}.html`, body);
  const shapes = digest(url, res, body);
  collected.push({ url, body, shapes });
}

// ── The payload itself, last, so a log tail still carries it ─────────────────

for (const { url, body, shapes } of collected) {
  console.log(`\n\n=================== PAYLOAD: ${url} ===================`);

  for (const shape of shapes) {
    console.log(`\n----- ${shape.kind} (first ${MAX_JSON_LOG} chars) -----`);
    console.log(shape.payload.slice(0, MAX_JSON_LOG));
  }

  const regions = candidateRegions(body);
  console.log(`\n----- candidate timetable regions: ${regions.length} -----`);
  let budget = MAX_TEXT_LOG;
  for (const [i, region] of regions.entries()) {
    if (budget <= 0) break;
    const text = visibleText(region.html);
    if (!text) continue;
    const slice = text.slice(0, Math.min(budget, 12_000));
    budget -= slice.length;
    console.log(`\n--- region ${i} [${region.kind}] ---\n${slice}`);
  }

  if (regions.length === 0) {
    console.log(`\n--- no region matched; whole-page visible text (first ${MAX_TEXT_LOG}) ---`);
    console.log(visibleText(body).slice(0, MAX_TEXT_LOG));
  }
}

console.log(
  outDir
    ? `\n[probe] snapshots saved to ${outDir}/`
    : "\n[probe] pass an output dir to also save page snapshots",
);
