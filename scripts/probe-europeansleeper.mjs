// scripts/probe-europeansleeper.mjs
// One-shot reconnaissance for the European Sleeper adapter: the dev sandbox
// cannot reach europeansleeper.eu, so this runs from CI ("Probe European
// Sleeper source" workflow) where egress is open. It fetches the official
// surfaces, reports their structure (is the timetable in __NEXT_DATA__? DOM
// tables? which /api/ endpoints do the booking bundles call?), and saves
// sanitized snapshots as a workflow artifact so parseTimetableHtml() in
// scripts/adapters/europeansleeper.mjs can be finalized against real data.
//
// Read-only: GET requests with a descriptive User-Agent, nothing else.
// Run: node scripts/probe-europeansleeper.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";

const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";
const TARGETS = [
  "https://www.europeansleeper.eu/timetable",
  "https://www.europeansleeper.eu/en/timetable",
  "https://www.europeansleeper.eu/",
  "https://booking.europeansleeper.eu/",
];
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const outDir = process.argv[2] ?? null;

function slug(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").replace(/_+$/, "");
}

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
    const body = await res.text();
    return { res, body };
  } catch (err) {
    return { error: err.message };
  }
}

function reportHtml(url, res, body) {
  console.log(`\n━━━ ${url}`);
  console.log(`  status: ${res.status} | content-type: ${res.headers.get("content-type")}`);
  console.log(`  server: ${res.headers.get("server")} | cf-ray: ${res.headers.get("cf-ray") ?? "-"}`);
  console.log(`  length: ${body.length}`);

  const nextData = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  console.log(`  __NEXT_DATA__: ${nextData ? `yes (${nextData[1].length} bytes)` : "no"}`);
  if (nextData) {
    try {
      const json = JSON.parse(nextData[1]);
      console.log(`  __NEXT_DATA__ top-level keys: ${Object.keys(json).join(", ")}`);
      const pageProps = json?.props?.pageProps;
      if (pageProps) console.log(`  pageProps keys: ${Object.keys(pageProps).join(", ")}`);
    } catch {
      console.log("  __NEXT_DATA__ present but not parseable as JSON");
    }
  }
  const nuxt = /__NUXT__|__nuxt/.test(body);
  console.log(`  Nuxt markers: ${nuxt ? "yes" : "no"}`);
  console.log(`  <table> tags: ${(body.match(/<table/gi) ?? []).length}`);

  // Train numbers the BoT data knows about — are they server-rendered?
  for (const n of ["452", "453", "454", "455", "474", "475"]) {
    if (body.includes(n)) console.log(`  contains train number ${n}: yes`);
  }

  const apiPaths = [...new Set(body.match(/["'](\/api\/[^"'\s]{1,120})["']/g) ?? [])];
  if (apiPaths.length) console.log(`  /api/ paths in HTML: ${apiPaths.slice(0, 15).join(" ")}`);
  const scripts = [...new Set([...body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))];
  console.log(`  script srcs (${scripts.length}): ${scripts.slice(0, 10).join("\n    ")}`);
  return scripts;
}

async function probeBundles(baseUrl, scripts) {
  const sameHost = scripts
    .map((s) => (s.startsWith("http") ? s : new URL(s, baseUrl).href))
    .filter((s) => s.includes(new URL(baseUrl).host))
    .slice(0, 4);
  for (const src of sameHost) {
    const { res, body, error } = await get(src, "*/*");
    if (error || !res.ok) continue;
    const apiHits = [...new Set(body.match(/["'`](\/?api\/[^"'`\s]{1,120})["'`]/g) ?? [])];
    const vendorHits = [...new Set(body.match(/sqills|s3passenger|turnit|graphql|booking-api/gi) ?? [])];
    if (apiHits.length || vendorHits.length) {
      console.log(`\n  bundle ${src}`);
      if (apiHits.length) console.log(`    api paths: ${apiHits.slice(0, 20).join(" ")}`);
      if (vendorHits.length) console.log(`    vendor markers: ${vendorHits.join(", ")}`);
      save(`bundle-${slug(src)}.js`, body);
    }
  }
}

const results = [];
for (const url of TARGETS) {
  const { res, body, error } = await get(url);
  if (error) {
    console.log(`\n━━━ ${url}\n  FAILED: ${error}`);
    continue;
  }
  save(`${slug(url)}.html`, body);
  const scripts = reportHtml(url, res, body);
  results.push({ url, scripts });
}

for (const { url, scripts } of results) {
  await probeBundles(url, scripts);
}

console.log(
  outDir
    ? `\n[probe] snapshots saved to ${outDir}/ — download the workflow artifact and finalize parseTimetableHtml()`
    : "\n[probe] pass an output dir to also save page snapshots",
);
