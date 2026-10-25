// scripts/probe-uty.mjs
// What O'zbekiston temir yo'llari's (Uzbekistan Railways, UTY) own ticket shop
// serves to an automated client, printed to the job log.
//
// The dev sandbox cannot reach the shop (403 at the egress proxy), so this is
// how its reader gets written against real answers. What the runs found:
//   - 2026-10-25: eticket.railway.uz answers every path with a 301 to
//     eticket.uzrailpass.uz, an Angular app. Its bundle names every call the
//     page makes; the ones read here are the public, before-login ones:
//       GET  /api/v1/csrf-token                 (the page calls it on load; sets XSRF-TOKEN)
//       POST /api/v1/handbook/stations/list     {name}            station search (204 for "")
//       POST /api/v3/handbook/trains/list       {directions:{forward:{date,depStationCode,arvStationCode}}}
//       POST /api/v1/handbook/trains/route      {number}          a train's route
//       GET  /api/v1/handbook/stations/schedule/{code}            a station's departures
//     reCAPTCHA is attached by the page's interceptor to login, registration
//     and ticket-check calls only; a 429 is the shop's "user_blocked".
//   - The search answers every train between two stations with its type,
//     number (a letter suffix per direction: 080Ф out, 080Ь back), departure
//     and arrival ("dd.MM.yyyy HH:mm", Tashkent time), the train's own ends
//     (originRoute), brand, and per car type (Plaskartli / Kupe / SV / Umumiy /
//     O'rindiqli) the tariff in so'm by service class (3П, 2К, 1Л, …). A
//     train with no place left on sale has no `cars`.
// This run reads the route and station-board calls and looks up the station
// codes the night trains' far ends need.
//
// Read-only: GETs plus the page's own search POSTs, an honest User-Agent, at
// most MAX_REQUESTS, 1.5 s apart, nothing booked. A block (detectBlock) stops
// the run for that host.
// Run: node scripts/probe-uty.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const outDir = process.argv[2] ?? null;
const ORIGIN = "https://eticket.uzrailpass.uz";
const MAX_REQUESTS = 80;
const SPACING_MS = 1_500;
const DATE_OFFSET_DAYS = 7;

// Station searches: the far ends of the night trains, plus the internationals.
const STATION_QUERIES = ["Olot", "Shovot", "Qo'ng'irot", "Sariosiyo", "Toshkent", "Andijon", "Moskva", "Olma", "Dushanbe", "Qozon", "Volgograd", "Kitob"];
// Route calls: one train per night corridor, both directions where known.
const ROUTES = ["080Ф", "080Ь", "054Ф", "056Ж", "058З", "072Ф", "082Ф", "125Ч", "126Ф", "127Ф", "129Ф", "124Ф", "712Ф"];
// Station boards.
const BOARDS = ["2900000", "2900172"];
// Searches whose far end is looked up by name above.
const SEARCHES = [
  ["2900000", "Olot"],
  ["2900000", "Shovot"],
  ["2900000", "Qo'ng'irot"],
  ["2900000", "Sariosiyo"],
  ["2900000", "Moskva"],
  ["2900000", "Olma"],
  ["2900000", "Dushanbe"],
];
// One corridor on seven consecutive nights: which nights each train runs.
const WEEK = ["2900000", "2900172"];

let requests = 0;
const cookies = new Map();
const blockedHosts = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").slice(0, 120);

function rememberCookies(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return raw;
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function request(url, { method = "GET", json = null, accept = "application/json, text/plain, */*", lang = "uz" } = {}) {
  const host = new URL(url).host;
  if (blockedHosts.has(host)) return { url, skipped: "host blocked earlier" };
  if (requests >= MAX_REQUESTS) return { url, skipped: "request budget spent" };
  requests += 1;
  await sleep(SPACING_MS);
  const headers = {
    "User-Agent": HONEST_USER_AGENT,
    Accept: accept,
    "Accept-Language": lang,
    "X-Custom-Language": lang,
    "device-type": "BROWSER",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/${lang}/home`,
  };
  if (cookies.size) headers.Cookie = cookieHeader();
  if (cookies.has("XSRF-TOKEN")) headers["X-XSRF-TOKEN"] = decodeURIComponent(cookies.get("XSRF-TOKEN"));
  let body;
  if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const setCookies = rememberCookies(res);
    const text = await res.text();
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson: true });
    return { url, status: res.status, type: res.headers.get("content-type") ?? "", location: res.headers.get("location"), body: text, block, setCookies };
  } catch (err) {
    return { url, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

function save(name, body) {
  if (!outDir || !body) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug(name)}.json`), body);
}

function describe(label, page) {
  console.log(`\n## ${label}`);
  if (page.skipped) return console.log(`skipped: ${page.skipped}`), false;
  if (page.error) return console.log(`error: ${page.error}`), false;
  console.log(`status ${page.status}, ${page.type}, ${page.body.length} chars${page.location ? `, location ${page.location}` : ""}`);
  if (page.setCookies?.length) console.log(`set-cookie names: ${page.setCookies.map((c) => c.split("=")[0]).join(", ")}`);
  if (page.block) console.log(`BLOCK SIGNAL ${JSON.stringify(page.block)}`);
  return true;
}

/** A call; JSON back or null. A 403 that is Spring's CSRF message is reported, not a block. */
async function call(method, pathname, json = null, label = `${method} ${pathname}`) {
  const res = await request(`${ORIGIN}${pathname}`, { method, json });
  if (!describe(label, res)) return null;
  if (res.status === 403 && /csrf token/i.test(res.body) && !/<html/i.test(res.body)) {
    console.log(`  CSRF refused: ${res.body.slice(0, 200)}`);
    return null;
  }
  if (res.block) {
    blockedHosts.add(new URL(res.url).host);
    console.log(`  body: ${res.body.slice(0, 600).replace(/\s+/g, " ")}`);
    return null;
  }
  save(label, res.body);
  if (!res.body) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    console.log(`  not JSON: ${res.body.slice(0, 600).replace(/\s+/g, " ")}`);
    return null;
  }
}

const ymd = (d) => d.toISOString().slice(0, 10);
const day = (n) => ymd(new Date(Date.now() + n * 86_400_000));

console.log(`# UTY eticket probe — ${new Date().toISOString()}`);

// 1. The page, then the token call it makes on load.
const home = await request(`${ORIGIN}/uz/home`, { accept: "text/html,*/*" });
if (!describe("/uz/home", home) || home.block) process.exit(0);
const token = await call("GET", "/api/v1/csrf-token");
console.log(`  answer: ${JSON.stringify(token).slice(0, 300)}; cookies now: ${[...cookies.keys()].join(", ")}`);

// 2. Station codes by name.
const codes = new Map();
console.log("\n# Stations");
for (const q of STATION_QUERIES) {
  const answer = await call("POST", "/api/v1/handbook/stations/list", { name: q }, `stations ${q}`);
  const list = Array.isArray(answer?.data) ? answer.data : Array.isArray(answer) ? answer : [];
  console.log(`  ${q}: ${list.length} hit(s); keys ${JSON.stringify(Object.keys(list[0] ?? {}))}`);
  for (const s of list.slice(0, 12)) console.log(`    ${JSON.stringify(s).slice(0, 300)}`);
  const first = list[0];
  if (first) codes.set(q, String(first.code ?? first.stationCode ?? first.id ?? ""));
}

// 3. Routes: the first answer whole, the rest as a digest.
console.log("\n# Routes");
let printedRoute = false;
for (const number of ROUTES) {
  const answer = await call("POST", "/api/v1/handbook/trains/route", { number }, `route ${number}`);
  const data = answer?.data ?? answer;
  if (!printedRoute && data) {
    console.log(`<<<ROUTE ${number}\n${JSON.stringify(answer, null, 1).slice(0, 30_000)}\n>>>ROUTE`);
    printedRoute = true;
  } else {
    console.log(`  ${number}: ${JSON.stringify(data).slice(0, 2_500)}`);
  }
}
// The bare number, and the other route call the page names.
const bare = await call("POST", "/api/v1/handbook/trains/route", { number: "080" }, "route 080 (bare)");
console.log(`  ${JSON.stringify(bare).slice(0, 1_500)}`);
const other = await call("POST", "/api/v1/trains/route", { trainNumber: "080Ф" }, "trains/route 080Ф");
console.log(`  ${JSON.stringify(other).slice(0, 3_000)}`);

// 4. Station boards.
console.log("\n# Station boards");
for (const code of BOARDS) {
  const answer = await call("GET", `/api/v1/handbook/stations/schedule/${code}`, null, `board ${code}`);
  console.log(`  ${JSON.stringify(answer).slice(0, 12_000)}`);
}

// 5. Searches to the far ends, a week out: digest per train with every tariff.
const digest = (trains) => {
  for (const t of trains) {
    const cars = (t.cars ?? []).map((c) => `${c.type}[${(c.tariffs ?? []).map((x) => `${x.classServiceType}:${x.tariff}`).join(",")}]`).join(" ");
    console.log(`  - ${t.number} ${t.type}/${t.brand} ${t.originRoute?.depStationName} → ${t.originRoute?.arvStationName} | ${t.departureDate} → ${t.arrivalDate} (${t.timeOnWay}) | ${t.subRoute?.depStationName}→${t.subRoute?.arvStationName} | ${cars || "no places"}${t.comment ? ` | comment ${t.comment}` : ""}`);
  }
};
console.log(`\n# Searches for ${day(DATE_OFFSET_DAYS)}`);
for (const [from, toName] of SEARCHES) {
  const to = /^\d+$/.test(toName) ? toName : codes.get(toName);
  if (!to) { console.log(`\n${from} → ${toName}: code unknown — skipped`); continue; }
  const answer = await call("POST", "/api/v3/handbook/trains/list", { directions: { forward: { date: day(DATE_OFFSET_DAYS), depStationCode: from, arvStationCode: to } } }, `search ${from}-${to}`);
  const trains = answer?.data?.directions?.forward?.trains ?? [];
  console.log(`  ${from} → ${toName} (${to}): ${trains.length} train(s)`);
  digest(trains);
}

// 6. One corridor, seven nights.
console.log(`\n# ${WEEK[0]} → ${WEEK[1]} on seven consecutive dates`);
for (let i = 0; i < 7; i++) {
  const date = day(DATE_OFFSET_DAYS + i);
  const answer = await call("POST", "/api/v3/handbook/trains/list", { directions: { forward: { date, depStationCode: WEEK[0], arvStationCode: WEEK[1] } } }, `week ${date}`);
  const trains = answer?.data?.directions?.forward?.trains ?? [];
  console.log(`  ${date} (${new Date(`${date}T00:00:00Z`).toUTCString().slice(0, 3)}): ${trains.map((t) => `${t.number} ${t.departureDate.slice(11)}`).join(", ") || "none"}`);
}

console.log(`\n# Requests: ${requests}; blocked hosts: ${[...blockedHosts].join(", ") || "none"}; cookies: ${[...cookies.keys()].join(", ")}`);
