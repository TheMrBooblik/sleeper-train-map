// scripts/probe-ktmb.mjs
// What Malaysia's official sources say about KTM Berhad's night trains,
// printed to the job log.
//
// The dev sandbox reaches neither api.data.gov.my nor any ktmb.com.my host, so
// this is how the nightly reader (scripts/adapters/ktmb.mjs) is written and
// checked against real answers rather than against a blog's timetable. It asks:
//   1. data.gov.my's GTFS Static for KTMB (api.data.gov.my/gtfs-static/ktmb,
//      the Ministry of Transport's open API, no key): which files, agencies
//      and routes it carries, and every trip that runs through a night, stop
//      by stop — the Ekspres Rakyat Timuran (JB Sentral – Tumpat) is the one
//      KTM sleeper still running, and this is where its official timetable is.
//   2. Whether the feed carries fares (fare_attributes / fare_rules / fare
//      products) — the cheapest honest way to a price.
//   3. What KTMB's own sites serve to an automated client: www.ktmb.com.my's
//      intercity/fare pages (plain text, printed) and online.ktmb.com.my, the
//      booking site (forms, scripts, captcha mentions) — read only, a block
//      ends that host.
//
// Read-only: one zip, bounded GETs, an honest User-Agent, nothing committed.
// Run: node scripts/probe-ktmb.mjs [outputDir]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { readCsv } from "./lib/gtfs.mjs";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const outDir = process.argv[2] ?? null;
const FEED_URL = process.env.KTMB_GTFS_URL || "https://api.data.gov.my/gtfs-static/ktmb";
const MAX_REQUESTS = 30;
const SPACING_MS = 1_000;
const MAX_TEXT = 12_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (url) => url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").slice(0, 120);
function save(name, body) {
  if (!outDir || !body) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, slug(name)), body);
}

const toMin = (t) => {
  const m = /^(\d{1,3}):(\d{2})/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

console.log(`# KTMB probe — ${new Date().toISOString()}`);

// ── 1. GTFS ──────────────────────────────────────────────────────────────────
console.log(`\n# GTFS ${FEED_URL}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ktmb-gtfs-"));
let gtfsOk = false;
// data.gov.my answers with a redirect to the zip's storage address, and a
// relative Location defeats downloadGtfs (the first run: "Invalid URL"), so
// this download follows redirects through fetch and unzips what lands.
try {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": HONEST_USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(180_000) });
  console.log(`status ${res.status}, ${res.headers.get("content-type")}, final URL ${res.url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  console.log(`${zip.length} bytes`);
  fs.writeFileSync(path.join(dir, "feed.zip"), zip);
  execSync(`unzip -o -q "${path.join(dir, "feed.zip")}" -d "${dir}"`);
  gtfsOk = true;
} catch (err) {
  console.log(`download failed: ${err?.message ?? err}`);
}

if (gtfsOk) {
  const files = fs.readdirSync(dir).filter((f) => f !== "feed.zip");
  console.log(`files: ${files.map((f) => `${f} (${fs.statSync(path.join(dir, f)).size} B)`).join(", ")}`);
  const table = (f) => (fs.existsSync(path.join(dir, f)) ? readCsv(path.join(dir, f)) : []);
  const raw = (f, lines = 40) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, "utf8");
    save(`gtfs-${f}`, text);
    const all = text.split(/\r?\n/);
    console.log(`\n## ${f} (${all.length} lines)\n${all.slice(0, lines).join("\n")}`);
  };
  for (const f of ["feed_info.txt", "agency.txt", "routes.txt", "calendar.txt"]) raw(f, 200);
  raw("calendar_dates.txt", 30);
  for (const f of files.filter((f) => /^fare|^rider|^timeframe|^network|^area/i.test(f))) raw(f, 80);
  raw("stops.txt", 20);

  const routes = new Map(table("routes.txt").map((r) => [r.route_id, r]));
  const stops = new Map(table("stops.txt").map((s) => [s.stop_id, s]));
  const trips = table("trips.txt");
  console.log(`\ntrips.txt header: ${Object.keys(trips[0] ?? {}).join(", ")}`);
  const byTrip = new Map();
  for (const st of table("stop_times.txt")) {
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push(st);
  }
  for (const list of byTrip.values()) list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

  // Per route: how many trips, what they are called, how long they run.
  console.log("\n## Routes by trip count and longest run");
  const perRoute = new Map();
  for (const t of trips) {
    const st = byTrip.get(t.trip_id) ?? [];
    const dep = toMin(st[0]?.departure_time || st[0]?.arrival_time);
    const arr = toMin(st.at(-1)?.arrival_time || st.at(-1)?.departure_time);
    const len = dep != null && arr != null ? (arr >= dep ? arr - dep : arr + 1440 - dep) : null;
    const r = perRoute.get(t.route_id) ?? { trips: 0, names: new Set(), heads: new Set(), maxLen: 0 };
    r.trips += 1;
    if (t.trip_short_name) r.names.add(t.trip_short_name);
    if (t.trip_headsign) r.heads.add(t.trip_headsign);
    if (len != null && len > r.maxLen) r.maxLen = len;
    perRoute.set(t.route_id, r);
  }
  for (const [id, r] of [...perRoute].sort((a, b) => b[1].maxLen - a[1].maxLen)) {
    const route = routes.get(id) ?? {};
    console.log(
      `- ${id} type=${route.route_type} short=${JSON.stringify(route.route_short_name)} long=${JSON.stringify(route.route_long_name)} agency=${route.agency_id} trips=${r.trips} longest=${Math.floor(r.maxLen / 60)}h${String(r.maxLen % 60).padStart(2, "0")} names=[${[...r.names].slice(0, 12).join(", ")}] heads=[${[...r.heads].slice(0, 6).join(" | ")}]`,
    );
  }

  // Every trip that runs through a night: leaves in the evening or crosses
  // midnight, at least five hours. Printed whole — this is the timetable.
  console.log("\n## Trips through a night (≥ 5 h and crossing midnight, or leaving 18:00 or later for ≥ 5 h)");
  let night = 0;
  for (const t of trips) {
    const st = byTrip.get(t.trip_id) ?? [];
    if (st.length < 2) continue;
    const dep = toMin(st[0].departure_time || st[0].arrival_time);
    const arrRaw = toMin(st.at(-1).arrival_time || st.at(-1).departure_time);
    if (dep == null || arrRaw == null) continue;
    const crosses = arrRaw >= 1440 || arrRaw < dep;
    const len = arrRaw >= dep ? arrRaw - dep : arrRaw + 1440 - dep;
    if (len < 300 || !(crosses || dep >= 18 * 60)) continue;
    night += 1;
    const route = routes.get(t.route_id) ?? {};
    console.log(
      `\n### trip ${t.trip_id} route=${t.route_id} (${route.route_short_name} / ${route.route_long_name}) short=${JSON.stringify(t.trip_short_name)} head=${JSON.stringify(t.trip_headsign)} dir=${t.direction_id} service=${t.service_id} shape=${t.shape_id ?? ""} ${Math.floor(len / 60)}h${String(len % 60).padStart(2, "0")}`,
    );
    for (const s of st) {
      const stop = stops.get(s.stop_id) ?? {};
      console.log(`  ${String(s.stop_sequence).padStart(3)} ${s.arrival_time} ${s.departure_time} ${s.stop_id} ${stop.stop_name} (${stop.stop_lat},${stop.stop_lon}) pickup=${s.pickup_type ?? ""} drop=${s.drop_off_type ?? ""}`);
    }
  }
  console.log(`\n${night} trip(s) through a night`);

  // Their calendars, so the operating days and validity can be read.
  const nightServices = new Set(
    trips
      .filter((t) => {
        const st = byTrip.get(t.trip_id) ?? [];
        const dep = toMin(st[0]?.departure_time);
        const arr = toMin(st.at(-1)?.arrival_time);
        return dep != null && arr != null && (arr >= 1440 || arr < dep) && (arr >= dep ? arr - dep : arr + 1440 - dep) >= 300;
      })
      .map((t) => t.service_id),
  );
  console.log(`\n## Calendars of those trips: ${[...nightServices].join(", ")}`);
  for (const c of table("calendar.txt").filter((c) => nightServices.has(c.service_id))) console.log(`  ${JSON.stringify(c)}`);
  const cd = table("calendar_dates.txt").filter((c) => nightServices.has(c.service_id));
  console.log(`  calendar_dates rows: ${cd.length}; first ${cd.slice(0, 20).map((c) => `${c.service_id}:${c.date}:${c.exception_type}`).join(" ")}`);
  if (fs.existsSync(path.join(dir, "shapes.txt"))) {
    const shapes = new Map();
    for (const s of table("shapes.txt")) shapes.set(s.shape_id, (shapes.get(s.shape_id) ?? 0) + 1);
    console.log(`\nshapes: ${shapes.size} shape(s), points: ${[...shapes].slice(0, 30).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
}

// ── 2. KTMB's own sites ──────────────────────────────────────────────────────
let requests = 0;
const blocked = new Set();
async function get(url) {
  const host = new URL(url).host;
  if (blocked.has(host)) return { url, skipped: "host blocked earlier" };
  if (requests >= MAX_REQUESTS) return { url, skipped: "request budget spent" };
  requests += 1;
  await sleep(SPACING_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": HONEST_USER_AGENT, Accept: "text/html,application/json,*/*;q=0.8", "Accept-Language": "en,ms;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    const block = detectBlock({ status: res.status, headers: res.headers, body }, { expectJson: false });
    if (block) blocked.add(host);
    return { url: res.url || url, status: res.status, type: res.headers.get("content-type") ?? "", body, block };
  } catch (err) {
    return { url, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}
const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(tr|p|div|li|h\d)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
function show(page, { text = true } = {}) {
  console.log(`\n## ${page.url}`);
  if (page.skipped) return console.log(`skipped: ${page.skipped}`), false;
  if (page.error) return console.log(`error: ${page.error}`), false;
  console.log(`status ${page.status}, ${page.type}, ${page.body.length} chars`);
  if (page.block) return console.log(`BLOCKED ${JSON.stringify(page.block)}`), false;
  save(page.url, page.body);
  if (text) console.log(textOf(page.body).slice(0, MAX_TEXT));
  return true;
}
const linksOf = (html, base) =>
  [...new Set([...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => {
    try {
      return new URL(m[1], base).href;
    } catch {
      return null;
    }
  }).filter(Boolean))];

console.log("\n# www.ktmb.com.my");
const home = await get("https://www.ktmb.com.my/");
if (show(home, { text: false })) {
  const links = linksOf(home.body, home.url);
  console.log(`links (${links.length}): ${links.join("  ")}`);
  const wanted = links.filter((l) => /ktmb\.com\.my/.test(l) && /intercity|ert|timuran|fare|tambang|traintime|timetable|jadual|ticket|sleeper|price/i.test(l));
  const seeds = ["https://www.ktmb.com.my/traintime.html"];
  for (const url of [...new Set([...seeds, ...wanted])].filter((u) => !/\.pdf/i.test(u)).slice(0, 4)) {
    const page = await get(url);
    if (!show(page)) continue;
    if (/traintime/i.test(url)) console.log(`all links: ${linksOf(page.body, page.url).filter((l) => !/\.css|\.js/.test(l)).join("  ")}`);
    const pdfs = linksOf(page.body, page.url).filter((l) => /\.pdf|\.jpe?g|\.png/i.test(l) && /ert|timuran|intercity|fare|tambang|jadual|timetable/i.test(l));
    if (pdfs.length) console.log(`documents: ${pdfs.join("  ")}`);
  }
}

console.log("\n# online.ktmb.com.my (booking)");
const shop = await get("https://online.ktmb.com.my/");
if (show(shop, { text: false })) {
  console.log(`inputs: ${[...shop.body.matchAll(/<input\b([^>]*)>/gi)].map((m) => m[1].replace(/\s+/g, " ").trim().slice(0, 160)).join("\n  ")}`);
  console.log(`forms: ${[...shop.body.matchAll(/<form\b([^>]*)>/gi)].map((m) => m[1].trim()).join("\n  ")}`);
  console.log(`scripts: ${[...shop.body.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).join("  ")}`);
  for (const m of shop.body.matchAll(/.{0,120}(recaptcha|turnstile|captcha|hcaptcha|login|sign in).{0,120}/gi)) console.log(`  …${m[0].replace(/\s+/g, " ")}…`);
  for (const m of shop.body.matchAll(/["'`](\/?[A-Za-z0-9_\-./]*(?:Trip|Search|Station|Fare|Price|Seat|api)[A-Za-z0-9_\-./?=]*)["'`]/g)) console.log(`  call-ish: ${m[1]}`);
  // What the search form posts and how a station is chosen: the form whole,
  // the markup around one station, and the inline scripts that fill it in.
  const form = /<form\b[^>]*id="theForm"[\s\S]*?<\/form>/i.exec(shop.body)?.[0] ?? "";
  console.log(`\n### the search form (${form.length} chars)\n${form.replace(/<option[\s\S]*?<\/option>/gi, "").replace(/\n\s*\n/g, "\n").slice(0, 8_000)}`);
  for (const name of ["JB SENTRAL", "TUMPAT"]) {
    const at = shop.body.indexOf(name);
    if (at >= 0) console.log(`\n### around ${name}\n${shop.body.slice(Math.max(0, at - 700), at + 300)}`);
  }
  for (const m of shop.body.matchAll(/<script\b(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!/Trip|StationData|TimeTable|ajax|\$\.post|fetch\(/i.test(m[1])) continue;
    console.log(`\n--- inline script (${m[1].length} chars)\n${m[1].replace(/\n\s*\n/g, "\n").slice(0, 8_000)}`);
  }
  const own = [...shop.body.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => new URL(m[1], shop.url).href)
    .filter((u) => /online\.ktmb\.com\.my/.test(u));
  for (const src of own.slice(0, 6)) {
    const js = await get(src);
    if (!show(js, { text: false })) continue;
    for (const m of js.body.matchAll(/.{0,200}(\/Trip|StationData|TimeTable|\$\.(?:ajax|post|get)|fetch\().{0,400}/g)) console.log(`  js: ${m[0].replace(/\s+/g, " ")}`);
  }
}

console.log(`\n# done — ${requests} web request(s)`);
