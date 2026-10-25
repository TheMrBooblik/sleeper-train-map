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
//   - The route call (handbook/trains/route) and the station boards
//     (handbook/stations/schedule/{code}) answer 401: they need a login, which
//     this map never does, so no call here reads them again.
//   - One corridor over seven dates gives each train's nights (Toshkent → Xiva:
//     056 Tue/Wed/Fri/Sat, 125 Mon/Tue/Fri/Sat, 076 Mon). The digits name the
//     train; the letter after them changes by date (125Ч, 125Ф).
// This run prints the station search's raw answer, and searches from Toshkent
// to every station whose code is known: a night train answers a search exactly
// when it serves both stations, so those searches are its official stop list.
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
const MAX_REQUESTS = 60;
const SPACING_MS = 1_500;
const DATE_OFFSET_DAYS = 7;

// Station searches: the far ends of the night trains, plus the internationals.
const STATION_QUERIES = ["Olot", "Shovot", "Qo'ng'irot", "Qung'irot", "Sariosiyo", "Denov", "Kattaqo'rg'on", "Miskin", "Beruniy", "Qorako'l", "Moskva", "Olmaota", "Dushanbe", "Sh", "Toshkent"];
// Codes known from open-source clients of the shop (mrmuminov/railway_finder).
const KNOWN = {
  Guliston: "2900850", Jizzax: "2900720", Samarqand: "2900700", Navoiy: "2900930", Buxoro: "2900800",
  Qarshi: "2900750", Termiz: "2900255", Urganch: "2900790", Xiva: "2900172", Nukus: "2900970",
  Andijon: "2900680", Namangan: "2900940", "Qo'qon": "2900880", "Marg'ilon": "2900920", Pop: "2900693",
};

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
console.log("\n# Stations");
for (const q of STATION_QUERIES) {
  const answer = await call("POST", "/api/v1/handbook/stations/list", { name: q }, `stations ${q}`);
  console.log(`  raw: ${JSON.stringify(answer).slice(0, 1_500)}`);
}

// One line per train: number, ends, times, every car type with its tariffs.
const digest = (trains) => {
  for (const t of trains) {
    const cars = (t.cars ?? []).map((c) => `${c.type}[${(c.tariffs ?? []).map((x) => `${x.classServiceType}:${x.tariff}`).join(",")}]`).join(" ");
    console.log(`  - ${t.number} ${t.type}/${t.brand} ${t.originRoute?.depStationName} → ${t.originRoute?.arvStationName} | ${t.departureDate} → ${t.arrivalDate} (${t.timeOnWay}) | ${t.subRoute?.depStationName}→${t.subRoute?.arvStationName} | ${cars || "no places"}${t.comment ? ` | comment ${t.comment}` : ""}`);
  }
};
// 3. Toshkent to every known station, one date, both ways: which night
// trains answer for which station, and at what time.
for (const [name, code] of Object.entries(KNOWN)) {
  for (const [from, to] of [["2900000", code], [code, "2900000"]]) {
    const answer = await call("POST", "/api/v3/handbook/trains/list", { directions: { forward: { date: day(DATE_OFFSET_DAYS), depStationCode: from, arvStationCode: to } } }, `search ${from}-${to}`);
    const trains = answer?.data?.directions?.forward?.trains ?? [];
    console.log(`  ${from === "2900000" ? `Toshkent → ${name}` : `${name} → Toshkent`}: ${trains.length} train(s)`);
    digest(trains);
  }
}

// 4. The shop's own currency rates (the page shows prices in other
// currencies), and the European Commission's monthly rate for the so'm, for
// an "≈ €" beside a fare.
const rates = await call("GET", "/api/v1/payment/currency-rates", null, "currency-rates");
console.log(`  ${JSON.stringify(rates).slice(0, 1_500)}`);
try {
  const res = await fetch("https://ec.europa.eu/budg/inforeuro/api/public/currencies/uzs", { headers: { "User-Agent": HONEST_USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  console.log(`\n## InforEuro UZS\nstatus ${res.status}\n${(await res.text()).slice(0, 1_500)}`);
} catch (err) {
  console.log(`\n## InforEuro UZS\nerror ${err.message}`);
}

console.log(`\n# Requests: ${requests}; blocked hosts: ${[...blockedHosts].join(", ") || "none"}; cookies: ${[...cookies.keys()].join(", ")}`);
