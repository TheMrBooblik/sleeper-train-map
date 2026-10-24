// scripts/probe-uty.mjs
// What O'zbekiston temir yo'llari's (Uzbekistan Railways, UTY) own ticket shop,
// eticket.railway.uz, serves to an automated client, printed to the job log.
//
// The dev sandbox cannot reach railway.uz or eticket.railway.uz (403 at the
// egress proxy), so this is how a reader for them gets written against real
// answers. What is known before the first run, from open-source clients of the
// same site (mrmuminov/railway_finder, AydosJs/railway-bot):
//   - POST /api/v3/handbook/trains/list
//       {"directions":{"forward":{"date":"YYYY-MM-DD","depStationCode":"2900000","arvStationCode":"2900800"}}}
//     answers data.directions.forward.trains[], each with cars[] → tariffs[]
//     (price in so'm, freeSeats) — the search the shop's own page makes
//     **before login**. The site's reCAPTCHA is on the login page; login,
//     seat maps, orders and payment are never touched here.
//   - POST /api/v1/handbook/stations/list {"name":""} — every station's code.
//   - Calls carry a double-submit CSRF pair: an XSRF-TOKEN cookie and the same
//     value as an X-XSRF-TOKEN header. This probe uses the cookie the server
//     itself sets, as the shop's page does; it never mints one.
//
// Read-only: GETs plus the site's own search POSTs, an honest User-Agent, at
// most MAX_REQUESTS, 1.5 s apart, nothing booked. A block (detectBlock) stops
// the run for that host.
// Run: node scripts/probe-uty.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const outDir = process.argv[2] ?? null;
const ORIGIN = "https://eticket.railway.uz";
const MAX_REQUESTS = 60;
const SPACING_MS = 1_500;
const DATE_OFFSET_DAYS = 7;

// Searches to make: [from, to] by station code where already known, else by
// name, resolved through stations/list. Both directions of the corridors the
// night trains are reported on, plus one short one (Toshkent → Samarqand) to
// see whether a long train is answered for a stretch of its route, and one
// international (Toshkent → Moskva) to see whether the shop sells those.
const SAMPLES = [
  ["2900000", "2900172"], // Toshkent → Xiva
  ["2900172", "2900000"],
  ["2900000", "2900790"], // Toshkent → Urganch
  ["2900000", "2900970"], // Toshkent → Nukus
  ["2900000", "2900255"], // Toshkent → Termiz
  ["2900255", "2900000"],
  ["2900000", "Olot"],
  ["2900000", "Shovot"],
  ["2900000", "Qo'ng'irot"],
  ["2900680", "2900172"], // Andijon → Xiva
  ["2900680", "2900255"], // Andijon → Termiz
  ["2900000", "2900700"], // Toshkent → Samarqand
  ["2900000", "2900800"], // Toshkent → Buxoro
  ["2900000", "Moskva"],
  ["2900000", "Olmaota"],
];

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
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson: Boolean(json) });
    return { url, status: res.status, type: res.headers.get("content-type") ?? "", location: res.headers.get("location"), body: text, block, setCookies, server: res.headers.get("server") };
  } catch (err) {
    return { url, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

function save(name, body) {
  if (!outDir || !body) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug(name)}.txt`), body);
}

function describe(label, page) {
  console.log(`\n## ${label}`);
  if (page.skipped) return console.log(`skipped: ${page.skipped}`), false;
  if (page.error) return console.log(`error: ${page.error}`), false;
  console.log(`status ${page.status}, ${page.type}, ${page.body.length} chars, server ${page.server}${page.location ? `, location ${page.location}` : ""}`);
  if (page.setCookies?.length) console.log(`set-cookie names: ${page.setCookies.map((c) => c.split("=")[0]).join(", ")}`);
  if (page.block) console.log(`BLOCK SIGNAL ${JSON.stringify(page.block)}`);
  return true;
}

/**
 * A search POST. A 403 whose answer is JSON and which sets an XSRF-TOKEN
 * cookie is the CSRF handshake (the first call a browser makes gets the same),
 * not a refusal: it is retried once with the server's own token. Anything else
 * detectBlock calls a block is final for the host.
 */
async function api(pathname, json, { lang = "uz", label = pathname } = {}) {
  const url = `${ORIGIN}${pathname}`;
  let res = await request(url, { method: "POST", json, lang });
  if (!describe(`POST ${label}`, res)) return null;
  const handshake = res.status === 403 && res.setCookies?.some((c) => /^XSRF-TOKEN=/i.test(c)) && /json/i.test(res.type);
  if (handshake) {
    console.log("  403 with a fresh XSRF-TOKEN cookie — the CSRF handshake; retrying once with the server's token");
    res = await request(url, { method: "POST", json, lang });
    if (!describe(`POST ${label} (retry)`, res)) return null;
  }
  if (res.block) {
    blockedHosts.add(new URL(url).host);
    console.log(`  body: ${res.body.slice(0, 600).replace(/\s+/g, " ")}`);
    return null;
  }
  save(`${label}`, res.body);
  try {
    return JSON.parse(res.body);
  } catch {
    console.log(`  not JSON: ${res.body.slice(0, 600).replace(/\s+/g, " ")}`);
    return null;
  }
}

const ymd = (d) => d.toISOString().slice(0, 10);
const travel = ymd(new Date(Date.now() + DATE_OFFSET_DAYS * 86_400_000));

console.log(`# UTY eticket probe — ${new Date().toISOString()}, travel date ${travel}`);

// 1. robots.txt and the shop's own page: status, cookies, scripts.
const robots = await request(`${ORIGIN}/robots.txt`, { accept: "text/plain,*/*" });
if (describe("robots.txt", robots)) console.log(robots.body.slice(0, 2_000));

let home = await request(`${ORIGIN}/uz/home`, { accept: "text/html,*/*" });
if (home.error && /TIMEOUT|ECONNRESET|ETIMEDOUT/i.test(home.error)) {
  console.log(`first attempt: ${home.error} — retrying once in 30 s`);
  await sleep(30_000);
  home = await request(`${ORIGIN}/uz/home`, { accept: "text/html,*/*" });
}
if (!describe("/uz/home", home)) process.exit(0);
if (home.block) {
  console.log(home.body.slice(0, 1_500));
  process.exit(0);
}
save("home", home.body);
console.log(`cookies now: ${[...cookies.keys()].join(", ") || "none"}`);
console.log("recaptcha / captcha mentions:");
for (const m of home.body.matchAll(/.{0,120}(recaptcha|captcha|turnstile|ddos-guard).{0,120}/gi)) console.log(`  …${m[0].replace(/\s+/g, " ")}…`);

// 2. The SPA's own bundles, searched for the API paths it calls — the route
// (stop list) call in particular, which the open-source clients do not name.
const srcs = [...home.body.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => new URL(m[1], `${ORIGIN}/uz/home`).href)
  .filter((s) => s.startsWith(ORIGIN));
console.log(`\n# Scripts: ${srcs.join("  ")}`);
const apiPaths = new Set();
const seen = new Set();
for (let i = 0; i < srcs.length && seen.size < 10; i++) {
  const src = srcs[i];
  if (seen.has(src)) continue;
  seen.add(src);
  const js = await request(src, { accept: "*/*" });
  if (!describe(src, js) || js.block) continue;
  save(src, js.body);
  for (const m of js.body.matchAll(/["'`](\/?api\/v\d+\/[A-Za-z0-9_\-/{}$.]+)["'`]/g)) apiPaths.add(m[1]);
  for (const m of js.body.matchAll(/["'`]((?:handbook|trains?|route|stations?|schedule|timetable)\/[A-Za-z0-9_\-/{}$.]+)["'`]/g)) apiPaths.add(m[1]);
  // Lazy chunks the main bundle names (webpack): fetch the ones whose names say
  // they are about trains or routes, a handful at most.
  for (const m of js.body.matchAll(/["']([0-9a-z_-]*(?:train|route|search|schedule|home)[0-9a-z_-]*\.[0-9a-f]{8,}\.js)["']/gi)) {
    srcs.push(new URL(m[1], src).href);
  }
}
console.log(`\n# API paths named in the bundles (${apiPaths.size}):`);
for (const p of [...apiPaths].sort()) console.log(`  ${p}`);
const routeish = [...apiPaths].filter((p) => /route|stop|schedule|timetable|marshrut/i.test(p));
console.log(`route-like: ${routeish.join("  ") || "none"}`);
for (const p of routeish) {
  // Print the code around each use, so the body it posts can be read.
  for (const file of fs.existsSync(outDir ?? "") ? fs.readdirSync(outDir) : []) {
    if (!file.endsWith(".js.txt")) continue;
    const text = fs.readFileSync(path.join(outDir, file), "utf8");
    for (const m of text.matchAll(new RegExp(`.{0,400}${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.{0,600}`, "g"))) {
      console.log(`  --- ${file}: …${m[0]}…`);
    }
  }
}

// 3. Stations: the whole list in each language the shop offers.
const stationsByCode = new Map();
const stationNames = new Map();
for (const lang of ["uz", "ru", "en"]) {
  const answer = await api("/api/v1/handbook/stations/list", { name: "" }, { lang, label: `stations-${lang}` });
  const list = Array.isArray(answer?.data) ? answer.data : Array.isArray(answer?.data?.stations) ? answer.data.stations : Array.isArray(answer) ? answer : [];
  console.log(`  ${lang}: ${list.length} stations; top-level keys ${JSON.stringify(Object.keys(answer ?? {}))}; item keys ${JSON.stringify(Object.keys(list[0] ?? {}))}`);
  if (lang === "uz") console.log(`  first: ${JSON.stringify(list.slice(0, 3))}`);
  for (const s of list) {
    const code = String(s.code ?? s.stationCode ?? s.id ?? "");
    const name = String(s.name ?? s.stationName ?? s.title ?? "");
    if (!code) continue;
    if (!stationsByCode.has(code)) stationsByCode.set(code, {});
    stationsByCode.get(code)[lang] = name;
    stationNames.set(name.toLowerCase().replace(/[‘’ʻʼ`']/g, "'"), code);
  }
}
console.log(`\n# Station table (${stationsByCode.size}), code\tuz\tru\ten`);
for (const [code, names] of [...stationsByCode].sort()) console.log(`  ${code}\t${names.uz ?? ""}\t${names.ru ?? ""}\t${names.en ?? ""}`);

const codeFor = (v) => (/^\d+$/.test(v) ? v : stationNames.get(v.toLowerCase().replace(/[‘’ʻʼ`']/g, "'")) ?? null);

// 4. Searches. The first answer is printed whole; the rest as a digest of
// every train: number, brand/type, times, and every car type's tariffs.
console.log(`\n# Searches for ${travel}`);
let printedWhole = false;
for (const [fromRaw, toRaw] of SAMPLES) {
  const from = codeFor(fromRaw);
  const to = codeFor(toRaw);
  console.log(`\n${fromRaw} (${from}) → ${toRaw} (${to})`);
  if (!from || !to) { console.log("  station code unknown — skipped"); continue; }
  const answer = await api(
    "/api/v3/handbook/trains/list",
    { directions: { forward: { date: travel, depStationCode: from, arvStationCode: to } } },
    { label: `trains-${from}-${to}` },
  );
  const trains = answer?.data?.directions?.forward?.trains ?? [];
  if (!printedWhole && trains.length) {
    console.log(`\n<<<ANSWER ${from}-${to}\n${JSON.stringify(answer, null, 1).slice(0, 40_000)}\n>>>ANSWER`);
    printedWhole = true;
  } else if (!trains.length) {
    console.log(`  no trains; answer: ${JSON.stringify(answer).slice(0, 1_000)}`);
  }
  console.log(`  ${trains.length} trains; train keys ${JSON.stringify(Object.keys(trains[0] ?? {}))}`);
  for (const t of trains) {
    const head = { ...t };
    delete head.cars;
    console.log(`  - ${JSON.stringify(head).slice(0, 1_200)}`);
    for (const c of t.cars ?? []) {
      const tariffs = (c.tariffs ?? []).map((x) => `${x.classServiceType ?? x.class ?? ""}:${x.tariff}(${x.freeSeats})`).join(" ");
      const rest = { ...c };
      delete rest.tariffs;
      console.log(`      car ${JSON.stringify(rest).slice(0, 500)} | ${tariffs}`);
    }
  }
}

console.log(`\n# Requests: ${requests}; blocked hosts: ${[...blockedHosts].join(", ") || "none"}; cookies: ${[...cookies.keys()].join(", ")}`);
