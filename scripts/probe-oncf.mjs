// scripts/probe-oncf.mjs
// One-shot reconnaissance for the ONCF (Moroccan Railways) adapter: the dev
// sandbox cannot reach any oncf.ma / oncf-voyages.ma host, so this runs from CI
// ("Probe ONCF source" workflow) where egress is open.
//
// We are looking for a *stable, machine-readable* night-train source. The
// published community GTFS (MobilityDatabase mdb-3049) is unusable — it expired
// 2025-12-31 and models zero overnight service — so this probe checks the three
// official surfaces that could replace it, in descending order of preference:
//
//   1. oncf-voyages.ma  — the booking SPA. If its bundles call a JSON API, that
//      is the authoritative feed and the adapter becomes `kind: "json-api"`.
//   2. /telechargement-des-horaires — ONCF publishes timetable files at each
//      schedule change. A stable PDF/XLSX URL is a decent fallback.
//   3. oncf.ma/fr/Horaires — the legacy server-rendered search. A 2018-era
//      scraper (github.com/azihassan/oncf_schedule) drove it with per-station
//      code_g/code_r pairs; the codes below come from that catalogue and may
//      still be the identifiers the modern API uses.
//
// Read-only: GET requests with a descriptive User-Agent, nothing else. No
// booking, no login, no POST.
// Run: node scripts/probe-oncf.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";

const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const outDir = process.argv[2] ?? null;

// ONCF internal station identifiers (code_r 0093 = rail; 0011 = Supratours bus).
const STATIONS = {
  MARRAKECH: { code_r: "0093", code_g: "00110" },
  TANGER: { code_r: "0093", code_g: "00303" },
  "CASA VOYAGEURS": { code_r: "0093", code_g: "00200" },
  OUJDA: { code_r: "0093", code_g: "00490" },
};

// The two real overnight corridors, queried for an evening departure so a night
// train shows up in the results.
const CORRIDORS = [
  { from: "MARRAKECH", to: "TANGER" },
  { from: "CASA VOYAGEURS", to: "OUJDA" },
];

const STATIC_TARGETS = [
  "https://www.oncf-voyages.ma/",
  "https://www.oncf-voyages.ma/recherche-horaires",
  "https://www.oncf-voyages.ma/telechargement-des-horaires",
  "https://www.oncf.ma/fr/Voyageurs/Offres-voyageurs/Trains-de-nuit",
  "https://www.oncf.ma/fr/Horaires",
  "https://infos-trafic.oncf.ma/",
];

function slug(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").replace(/_+$/, "").slice(0, 120);
}

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  fs.writeFileSync(path.join(outDir, name), text.slice(0, MAX_SNAPSHOT_BYTES));
}

async function get(url, accept = "text/html,application/xhtml+xml") {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "fr,en;q=0.8" },
      redirect: "follow",
    });
    const body = await res.text();
    return { res, body };
  } catch (err) {
    return { error: err.message };
  }
}

/** Date a few days out, in the dd/mm/yyyy the legacy form expects. */
function searchDate(offsetDays = 5) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function legacySearchUrl(fromName, toName, time = "20:00") {
  const f = STATIONS[fromName];
  const t = STATIONS[toName];
  return (
    "https://www.oncf.ma/fr/Horaires" +
    `?from[${f.code_g}][${f.code_r}]=${encodeURIComponent(fromName)}` +
    `&to[${t.code_g}][${t.code_r}]=${encodeURIComponent(toName)}` +
    `&datedep=${encodeURIComponent(searchDate())}+${encodeURIComponent(time)}` +
    "&dateret=&is-ar=0"
  );
}

function reportHtml(url, res, body) {
  console.log(`\n━━━ ${url}`);
  console.log(`  status: ${res.status} | content-type: ${res.headers.get("content-type")}`);
  console.log(`  server: ${res.headers.get("server")} | cf-ray: ${res.headers.get("cf-ray") ?? "-"}`);
  console.log(`  length: ${body.length}`);

  // Which framework? Determines whether data is server-rendered or API-fed.
  const nextData = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextData) {
    console.log(`  __NEXT_DATA__: yes (${nextData[1].length} bytes)`);
    try {
      const json = JSON.parse(nextData[1]);
      console.log(`    top-level keys: ${Object.keys(json).join(", ")}`);
    } catch {
      console.log("    present but not parseable as JSON");
    }
  }
  const markers = {
    Nuxt: /__NUXT__|__nuxt/.test(body),
    Angular: /ng-version|angular/i.test(body),
    React: /react|_reactRoot/i.test(body),
    Drupal: /drupal-settings-json|\/sites\/default\/files/i.test(body),
  };
  const hit = Object.entries(markers).filter(([, v]) => v).map(([k]) => k);
  console.log(`  framework markers: ${hit.length ? hit.join(", ") : "none"}`);
  console.log(`  <table> tags: ${(body.match(/<table/gi) ?? []).length}`);

  // Night-train evidence: is the timetable actually in this response?
  const nightWords = ["couchette", "train de nuit", "trains de nuit", "cabine", "lit"];
  const found = nightWords.filter((w) => new RegExp(w, "i").test(body));
  if (found.length) console.log(`  night-train vocabulary: ${found.join(", ")}`);
  const evening = [...new Set(body.match(/\b2[0-3][:h][0-5]\d\b/g) ?? [])];
  if (evening.length) console.log(`  evening times present: ${evening.slice(0, 12).join(" ")}`);

  // Downloadable official timetables — the "stable artifact" fallback.
  const files = [...new Set([...body.matchAll(/href="([^"]+\.(?:pdf|xlsx?|csv|zip))"/gi)].map((m) => m[1]))];
  if (files.length) console.log(`  downloadable files (${files.length}):\n    ${files.slice(0, 15).join("\n    ")}`);

  const apiPaths = [...new Set(body.match(/["'](\/api\/[^"'\s]{1,120})["']/g) ?? [])];
  if (apiPaths.length) console.log(`  /api/ paths in HTML: ${apiPaths.slice(0, 15).join(" ")}`);

  const scripts = [...new Set([...body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))];
  console.log(`  script srcs (${scripts.length}):\n    ${scripts.slice(0, 10).join("\n    ")}`);
  return scripts;
}

/** Pull same-host JS bundles and look for the API the SPA talks to. */
async function probeBundles(baseUrl, scripts) {
  const sameHost = scripts
    .map((s) => {
      try {
        return s.startsWith("http") ? s : new URL(s, baseUrl).href;
      } catch {
        return null;
      }
    })
    .filter((s) => s && s.includes(new URL(baseUrl).host))
    .slice(0, 6);

  for (const src of sameHost) {
    const { res, body, error } = await get(src, "*/*");
    if (error || !res.ok) continue;
    const apiHits = [...new Set(body.match(/["'`](\/?(?:api|rest|graphql)\/[^"'`\s]{1,120})["'`]/g) ?? [])];
    const hostHits = [...new Set(body.match(/https?:\/\/[a-z0-9.-]*oncf[a-z0-9.-]*\/[^"'`\s]{0,80}/gi) ?? [])];
    const vendorHits = [...new Set(body.match(/sqills|s3passenger|turnit|amadeus|sabre|graphql|booking-api/gi) ?? [])];
    if (apiHits.length || hostHits.length || vendorHits.length) {
      console.log(`\n  bundle ${src}`);
      if (apiHits.length) console.log(`    api paths: ${apiHits.slice(0, 25).join(" ")}`);
      if (hostHits.length) console.log(`    oncf hosts: ${hostHits.slice(0, 15).join(" ")}`);
      if (vendorHits.length) console.log(`    vendor markers: ${[...new Set(vendorHits)].join(", ")}`);
      save(`bundle-${slug(src)}.js`, body);
    }
  }
}

// ── 1. Static surfaces ───────────────────────────────────────────────────────
const results = [];
for (const url of STATIC_TARGETS) {
  const { res, body, error } = await get(url);
  if (error) {
    console.log(`\n━━━ ${url}\n  FAILED: ${error}`);
    continue;
  }
  save(`${slug(url)}.html`, body);
  const scripts = reportHtml(url, res, body);
  results.push({ url, scripts });
}

// ── 2. Legacy schedule search, driven with real station codes ────────────────
console.log("\n\n═══ legacy /fr/Horaires search (2018-era codes) ═══");
for (const { from, to } of CORRIDORS) {
  const url = legacySearchUrl(from, to);
  const { res, body, error } = await get(url);
  if (error) {
    console.log(`\n━━━ ${from} → ${to}\n  FAILED: ${error}`);
    continue;
  }
  save(`search-${slug(`${from}-${to}`)}.html`, body);
  console.log(`\n━━━ ${from} → ${to}`);
  console.log(`  ${url}`);
  reportHtml(url, res, body);
  // The 2018 scraper read //div[@class="container"]/table/tbody/tr — still there?
  const rows = (body.match(/<tbody[\s\S]{0,40000}?<\/tbody>/i) ?? [""])[0];
  console.log(`  <tr> in first tbody: ${(rows.match(/<tr/gi) ?? []).length}`);
}

// ── 3. Bundle sweep for the booking API ──────────────────────────────────────
console.log("\n\n═══ JS bundle sweep ═══");
for (const { url, scripts } of results) {
  await probeBundles(url, scripts);
}

console.log(
  outDir
    ? `\n[probe] snapshots saved to ${outDir}/ — download the workflow artifact, then implement scripts/adapters/oncf.mjs and flip the registry entry to enabled:true`
    : "\n[probe] pass an output dir to also save page snapshots",
);
