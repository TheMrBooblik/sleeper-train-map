// scripts/probe-nj-fares.mjs
// What the Nightjet fare pass sees, printed from where egress is open
// ("Probe Nightjet fares" workflow; label a PR `run-probes`). The dev sandbox
// cannot reach nightjet.com, so scripts/lib/nj-fares.mjs was written from the
// endpoint's reverse-engineered OpenAPI notes. The first live run (2026-10-07)
// confirmed the answer's shape but not its size: the notes promise up to three
// journeys per call, and every answer held one. This prints, in order:
//   1. how many journeys one train's answer holds under each `max` the notes
//      allow (and without one), and what `forward=false` returns;
//   2. per train worth a look, the raw answer for three nights and what the
//      reader makes of it — the trains whose whole calendar came back without
//      a berth (seat-only, or no journey at all?) beside a sibling that prices.
// Read-only GETs, about thirty of them, spaced like the nightly pass.
// Run: node scripts/probe-nj-fares.mjs [outputDir] [train,train,…]

import fs from "node:fs";
import path from "node:path";
import {
  buildOffersUrl,
  journeysFromOffers,
  NJ_BOOKING_BASE,
  pricingEnds,
  viennaMidnightMs,
} from "./lib/nj-fares.mjs";
import { fetchWithTimeout } from "./lib/scrape-helpers.mjs";

const outDir = process.argv[2] ?? null;
const root = process.cwd();
const today = new Date().toISOString().slice(0, 10);
const plus = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const cap = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPACING_MS = 1200;

/** The control train first (it priced every night), then the ones that did not. */
const DEFAULT_TRAINS = [
  "NJ 40491", // Hamburg → Innsbruck: priced every night
  "NJ 493", // Hamburg → Wien: the same departure, no berth on any night
  "NJ 421", // Amsterdam → Innsbruck: priced every night
  "NJ 40421", // Amsterdam → Wien: the same departure, no berth on any night
  "EN 40458", // Praha → Zürich: a €296 sleeper and never a couchette
  "NJ 295", // München → Roma: one night priced in eight
  "NJ 470", // Zürich → Hamburg: berths on alternate nights
];

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), body);
}

async function get(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: null, text: "", error: err.cause?.code ?? err.message };
  } finally {
    await sleep(SPACING_MS);
  }
}

function read(text) {
  try {
    return journeysFromOffers(JSON.parse(text));
  } catch (err) {
    return { error: err.message };
  }
}

function summary(answer) {
  if (answer.error) return `✗ ${answer.error}`;
  const nights = answer.dates
    .map((d) => `${d} ${JSON.stringify(answer.nights[d].classes)}`)
    .join("; ");
  return `${answer.rows} journey(s): ${nights || "—"} · classes seen ${answer.seen.join(",") || "none"}`;
}

const file = JSON.parse(fs.readFileSync(path.join(root, "public/data/scraped/nightjet-trains.json"), "utf8"));
const trains = file.data?.trains ?? file.trains ?? {};
const wanted = (process.argv[3] ? process.argv[3].split(",") : DEFAULT_TRAINS).map((s) => s.trim());
const log = [];
const out = (line = "") => {
  console.log(line);
  log.push(line);
};

out(`═══ Nightjet fares probe — ${today} — ${NJ_BOOKING_BASE}`);

// 1. How many journeys does one answer hold?
const control = wanted.find((k) => trains[k] && pricingEnds(trains[k]));
if (control) {
  const ep = pricingEnds(trains[control]);
  const date = plus(7);
  const base = buildOffersUrl({ trainName: control, fromId: ep.fromId, toId: ep.toId, date }).split("?")[0];
  out(`\n── 1. Journeys per answer: ${control} ${ep.from} → ${ep.to}, from ${date} (${viennaMidnightMs(date)})`);
  for (const query of ["forward=true&max=1", "forward=true&max=3", "forward=true&max=7", "forward=true", "", "forward=false&max=3"]) {
    const url = query ? `${base}?${query}` : base;
    const { status, text, error } = await get(url);
    out(`   ?${query.padEnd(20)} → ${status ?? error} ${status === 200 ? summary(read(text)) : cap(text, 200)}`);
  }
}

// 2. Raw answers for the trains worth a look.
out("\n── 2. Raw answers");
for (const key of wanted) {
  const train = trains[key];
  const ep = train ? pricingEnds(train) : null;
  if (!ep) {
    out(`\n${key}: not in the trains file or no priceable ends`);
    continue;
  }
  out(`\n${key}: ${ep.from} (${ep.fromId}) → ${ep.to} (${ep.toId})`);
  for (const date of [plus(1), plus(7), plus(21)]) {
    const url = buildOffersUrl({ trainName: key, fromId: ep.fromId, toId: ep.toId, date });
    const { status, text, error } = await get(url);
    out(`   from ${date}: HTTP ${status ?? error}`);
    out(`     reader: ${status === 200 ? summary(read(text)) : "—"}`);
    out(`     raw:    ${cap(text.replace(/\s+/g, " "))}`);
    save(`${key.replace(/\s+/g, "_")}_${date}.json`, text);
  }
}

save("probe-nj-fares.log", `${log.join("\n")}\n`);
