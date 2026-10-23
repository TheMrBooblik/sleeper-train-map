// scripts/probe-ktmb.mjs
// What Malaysia's official sources say about KTM Berhad's night trains,
// printed to the job log.
//
// The dev sandbox reaches neither api.data.gov.my nor any ktmb.com.my host, so
// this is how the nightly reader (scripts/adapters/ktmb.mjs) was written and
// is checked against real answers. The first runs (2026-10-22) found:
//   - api.data.gov.my/gtfs-static/ktmb: 200 after a redirect to the zip on S3
//     (openapi-malaysia-transport…/ktmb/gtfs_ktmb.zip), ~230 KB: agency,
//     routes (ERT, SH, ETS, ST, five Komuter lines), trips (trip_id = train
//     number), stop_times, stops, calendar — no shapes, no fares. ERT 26/27
//     are the night trains.
//   - www.ktmb.com.my: plain pages; timetables are PDFs behind script, and
//     the fare documents (Tambang Fleksi, the Sep 2025 ticket terms) carry no
//     fare table.
//   - online.ktmb.com.my (KITS): the search works before login (GET /,
//     POST /Trip, POST /Trip/Trip) and lists each train with its times and
//     "Min. fare" (any class); the coach layout with per-place fares
//     (/Trip/LayoutV2) is offered only after login ("Login to view").
// This run repeats the feed read and one KITS search each way, and prints
// KTMB's fare documents as text (pdftotext), so a change shows up here first.
//
// Read-only: one zip, bounded GETs, an honest User-Agent, nothing committed.
// Run: node scripts/probe-ktmb.mjs [outputDir]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { readCsv } from "./lib/gtfs.mjs";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";
import { makeKitsClient } from "./lib/ktmb-kits.mjs";

const outDir = process.argv[2] ?? null;
const FEED_URL = process.env.KTMB_GTFS_URL || "https://api.data.gov.my/gtfs-static/ktmb";
const MAX_REQUESTS = 50;
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
const cookies = new Map();
async function get(url, { form = null, accept = "text/html,application/json,*/*;q=0.8", headers: extra = {} } = {}) {
  const host = new URL(url).host;
  if (blocked.has(host)) return { url, skipped: "host blocked earlier" };
  if (requests >= MAX_REQUESTS) return { url, skipped: "request budget spent" };
  requests += 1;
  await sleep(SPACING_MS);
  const headers = { "User-Agent": HONEST_USER_AGENT, Accept: accept, "Accept-Language": "en,ms;q=0.8", ...extra };
  const jar = [...cookies].filter(([k]) => k.startsWith(`${host}|`)).map(([k, v]) => `${k.slice(host.length + 1)}=${v}`);
  if (jar.length) headers.Cookie = jar.join("; ");
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = new URLSearchParams(form).toString();
  }
  try {
    const res = await fetch(url, { method: form ? "POST" : "GET", headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    for (const line of typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(`${host}|${pair.slice(0, eq).trim()}`, pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    const location = res.headers.get("location");
    if (location && res.status >= 300 && res.status < 400) return get(new URL(location, url).href, { accept, headers: extra });
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson: false });
    if (block) blocked.add(host);
    return { url, status: res.status, type: res.headers.get("content-type") ?? "", location, body: text, block };
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

console.log("\n# online.ktmb.com.my (KITS search, before login)");
// The client the nightly adapter uses (scripts/lib/ktmb-kits.mjs): the search
// form, POST /Trip, POST /Trip/Trip (the trains), POST /Trip/LayoutV2 (each
// train's coaches with every place's fare). Nothing is reserved.
{
  const kits = makeKitsClient({ log: (m) => console.log(m) });
  const travel = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  try {
    await kits.open();
    for (const [from, to] of [["37500", "86300"], ["86300", "37500"]]) {
      console.log(`\n## ${from} → ${to} on ${travel}`);
      let found;
      try {
        found = await kits.search({ from, to, date: travel });
      } catch (err) {
        console.log(`search failed: ${err.message}`);
        continue;
      }
      save(`kits-trips-${from}-${to}.html`, found.html);
      console.log(`### /Trip/Trip rows\n${(/<tbody[\s\S]*?<\/tbody>/i.exec(found.html)?.[0] ?? found.html).replace(/\n\s*\n/g, "\n").slice(0, 6_000)}`);
      const tripDatas = [...found.html.matchAll(/data-TripData\s*=\s*"([^"]+)"/gi)].map((m) => m[1].replace(/&#x2B;/gi, "+").replace(/&#x2F;/gi, "/").replace(/&#x3D;/gi, "="));
      console.log(`\n${tripDatas.length} train(s) with a TripData`);
      for (const [i, tripData] of tripDatas.slice(0, 3).entries()) {
        try {
          const data = await kits.layout({ searchData: found.searchData, tripData });
          const coaches = data.Coaches ?? [];
          console.log(`\n### layout ${i}: ${coaches.length} coach(es); top-level keys ${Object.keys(data).join(", ")}`);
          for (const c of coaches) {
            const kinds = new Map();
            for (const seat of c.Seats ?? []) {
              if (!seat.SeatNo) continue;
              const k = `${seat.SeatTypeName} | type ${seat.SeatType} | service ${seat.ServiceType} | ${seat.Price}`;
              const v = kinds.get(k) ?? { n: 0, open: 0 };
              v.n += 1;
              if (String(seat.Status) === "1") v.open += 1;
              kinds.set(k, v);
            }
            console.log(`- ${c.CoachLabel} (${c.SeatAvailable} available) keys=${Object.keys(c).filter((k) => k !== "Seats").join(",")}`);
            for (const [k, v] of kinds) console.log(`    ${k}: ${v.n} place(s), ${v.open} status 1`);
          }
          const slim = { ...data, Coaches: coaches.map((c) => ({ ...c, CoachData: "…", Seats: (c.Seats ?? []).filter((x) => x.SeatNo).map((x) => ({ SeatNo: x.SeatNo, Price: x.Price, SeatType: x.SeatType, SeatTypeName: x.SeatTypeName, ServiceType: x.ServiceType, Status: x.Status })) })) };
          console.log(`raw (slim): ${JSON.stringify(slim).slice(0, 20_000)}`);
          console.log(`first seat, every field: ${JSON.stringify((coaches[0]?.Seats ?? []).find((x) => x.SeatNo) ?? null)}`);
        } catch (err) {
          console.log(`layout ${i} failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.log(`KITS: ${err.message}`);
  }
  console.log(`KITS: ${kits.requests} request(s)`);
}

// Where a berth's price could be read without logging in. KITS shows each
// place's fare only after login, so this looks, read-only, at the two other
// public places that might state it: KITS's own timetable page, and the
// agents KTMB itself names as sellers (Easybook — KTMB's notice
// "Notis-Easybook" — and 12Go). A block (detectBlock) ends that host.
console.log("\n# Berth prices without login");
const around = (text, re, width = 220, max = 25) => {
  const out = [];
  for (const m of text.matchAll(re)) {
    out.push(text.slice(Math.max(0, m.index - width), m.index + width).replace(/\s+/g, " "));
    if (out.length >= max) break;
  }
  return out;
};
const describeForPrices = (page) => {
  if (!show(page, { text: false })) return;
  const text = textOf(page.body);
  console.log(`title: ${/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.body)?.[1]?.trim() ?? ""}`);
  console.log(`forms: ${[...page.body.matchAll(/<form\b([^>]*)>/gi)].map((m) => m[1].replace(/\s+/g, " ").trim().slice(0, 200)).join("\n  ") || "none"}`);
  for (const m of page.body.matchAll(/.{0,80}(recaptcha|turnstile|hcaptcha|captcha|cf-chl|challenge-platform).{0,80}/gi)) console.log(`  guard: …${m[0].replace(/\s+/g, " ")}…`);
  const prices = around(text, /(MYR|RM)\s?\d+(\.\d+)?/g);
  console.log(`price mentions (${prices.length}):`);
  for (const p of prices) console.log(`  …${p}…`);
  for (const p of around(text, /berth|katil|sleep|ADNS|Night/gi, 160, 10)) console.log(`  berth: …${p}…`);
  const api = [...new Set([...page.body.matchAll(/["'`]((?:https?:\/\/[^"'`\s]+)?\/[A-Za-z0-9_\-./]*(?:api|search|trip|train|fare|price|schedule|seat)[A-Za-z0-9_\-./?=&]*)["'`]/gi)].map((m) => m[1]))];
  console.log(`api-ish strings (${api.length}): ${api.slice(0, 80).join("  ")}`);
  const links = linksOf(page.body, page.url).filter((l) => /tumpat|johor|jb-?sentral|ktm|train/i.test(l));
  console.log(`relevant links (${links.length}): ${links.slice(0, 60).join("  ")}`);
  console.log(page.body.length < 5_000 ? `raw: ${page.body}` : text.slice(0, 3_000));
  return links;
};
{
  const travel = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const candidates = [
    // The first run (2026-10-23): /TimeTable/Search carries a reCAPTCHA,
    // Easybook's search answers "Your searching is too frequency" with a
    // reCAPTCHA (its page states only "Fare start from RM 56.00", KITS's
    // any-class minimum), and 12Go answers 202 with a 2 KB challenge page —
    // all three are bot protection, and this map never works around it. What
    // is left is whether KITS's own login is guarded too.
    "https://online.ktmb.com.my/Account/Login",
    `https://12go.asia/en/travel/johor-bahru/tumpat?date=${travel}&type=train`,
  ];
  const followed = new Set();
  for (const url of candidates) {
    const links = describeForPrices(await get(url)) ?? [];
    // One hop further on the agent sites: the first page naming Tumpat.
    const next = links.find((l) => /tumpat/i.test(l) && !followed.has(l) && !candidates.includes(l));
    if (next && /easybook|12go/.test(next)) {
      followed.add(next);
      describeForPrices(await get(next));
    }
  }
}

console.log(`\n# done — ${requests} web request(s)`);
