// scripts/probe-srt.mjs
// What State Railway of Thailand's own hosts serve to an automated client,
// printed to the job log.
//
// The dev sandbox cannot reach railway.co.th or dticket.railway.co.th, so this
// is how a reader for them gets written against real answers. The first run
// (2026-10-18) found:
//   - www.railway.co.th: connect timeout from GitHub's runners.
//   - ttsview.railway.co.th: a Cloudflare Turnstile challenge — a block, and
//     this map never works around one.
//   - namtang-api.otp.go.th/download/namtang-gtfs.zip: the Ministry of
//     Transport's national GTFS, 200, refreshed daily.
//   - dticket.railway.co.th/DTicketPublicWeb/home/Home: SRT's own booking
//     site, 200, with a plain search form (POST booking/booking).
// So this run reads D-Ticket closely: the station lists and inputs the search
// form carries, the scripts it loads (searched for the calls it makes), and
// one search per sample corridor, printing what the answer holds. Page text
// last, so the log tail is the raw material.
//
// Read-only: GETs plus the site's own search POST, an honest User-Agent, at
// most MAX_REQUESTS, nothing booked. A block (detectBlock) stops the run for
// that host, and a search that needs a captcha is reported, never attempted.
// Run: node scripts/probe-srt.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const outDir = process.argv[2] ?? null;
const MAX_REQUESTS = 40;
const MAX_TEXT_LOG = 15_000;
const SPACING_MS = 1_000;
const HOME = "https://dticket.railway.co.th/DTicketPublicWeb/home/Home";

// Corridors to try a search on: [from, to].
// English names exactly as getStation spells them.
// One corridor: the search's answer has the same shape on every line, and
// the fewer requests a discovery run makes, the better a guest it is.
const SAMPLES = [["Krung Thep Aphiwat", "Chiang Mai"]];

let requests = 0;
const cookies = new Map();
const blockedHosts = new Set();
const dumps = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (url) => url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").slice(0, 120);

function rememberCookies(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function request(url, { method = "GET", form = null, accept = "text/html,application/json,*/*;q=0.8", referer = null } = {}) {
  const host = new URL(url).host;
  if (blockedHosts.has(host)) return { url, skipped: "host blocked earlier" };
  if (requests >= MAX_REQUESTS) return { url, skipped: "request budget spent" };
  requests += 1;
  await sleep(SPACING_MS);
  const headers = { "User-Agent": HONEST_USER_AGENT, Accept: accept, "Accept-Language": "en,th;q=0.8" };
  if (cookies.size) headers.Cookie = cookieHeader();
  if (referer) headers.Referer = referer;
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = new URLSearchParams(form).toString();
  }
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    rememberCookies(res);
    const text = await res.text();
    const block = detectBlock({ status: res.status, headers: res.headers, body: text });
    if (block) blockedHosts.add(host);
    return { url, status: res.status, type: res.headers.get("content-type") ?? "", location: res.headers.get("location"), body: text, block };
  } catch (err) {
    return { url, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

function save(name, body) {
  if (!outDir || !body) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug(name)}.txt`), body);
}

const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function describe(label, page) {
  console.log(`\n## ${label}`);
  if (page.skipped) return console.log(`skipped: ${page.skipped}`), false;
  if (page.error) return console.log(`error: ${page.error}`), false;
  console.log(`status ${page.status}, ${page.type}, ${page.body.length} chars${page.location ? `, location ${page.location}` : ""}`);
  if (page.block) console.log(`BLOCKED ${JSON.stringify(page.block)}`);
  return !page.block;
}

/** Every <select name=…> with its options (value → label). */
function selectsOf(html) {
  const out = {};
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = /name\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? /id\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? "?";
    const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
      value: /value\s*=\s*["']([^"']*)["']/i.exec(o[1])?.[1] ?? "",
      label: o[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
      attrs: o[1].replace(/value\s*=\s*["'][^"']*["']/i, "").trim().slice(0, 120),
    }));
    (out[name] ??= []).push(options);
  }
  return out;
}

/** Every <input> with its attributes, for the search form. */
function inputsOf(html) {
  return [...html.matchAll(/<input\b([^>]*)>/gi)].map((m) => m[1].replace(/\s+/g, " ").trim().slice(0, 200));
}

const base = (html, url) => {
  const href = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  return href ? new URL(href, url).href : url;
};

console.log(`# SRT D-Ticket probe — ${new Date().toISOString()}`);

// 1. Home: the form, its inputs, its station lists, its scripts.
const home = await request(HOME);
if (!describe(HOME, home)) process.exit(0);
save("home", home.body);
const homeBase = base(home.body, HOME);
console.log(`<base>: ${homeBase}`);
console.log(`cookies: ${[...cookies.keys()].join(", ")}`);
console.log("\n### inputs");
for (const i of inputsOf(home.body)) console.log(`  <input ${i}>`);
const selects = selectsOf(home.body);
console.log("\n### selects");
for (const [name, lists] of Object.entries(selects)) {
  lists.forEach((opts, i) => {
    console.log(`- ${name}[${i}]: ${opts.length} options`);
    for (const o of opts.slice(0, 400)) console.log(`    ${JSON.stringify(o.value)} ${o.label}${o.attrs ? `  {${o.attrs}}` : ""}`);
  });
}
console.log("\n### recaptcha / turnstile mentions");
for (const m of home.body.matchAll(/.{0,160}(recaptcha|grecaptcha|turnstile|captcha).{0,160}/gi)) console.log(`  …${m[0].replace(/\s+/g, " ")}…`);

console.log("\n### inline scripts mentioning ajax / url / booking");
for (const m of home.body.matchAll(/<script\b(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)) {
  const js = m[1];
  if (!/ajax|url|booking|station|province|\$\.post|fetch\(/i.test(js)) continue;
  console.log(`--- inline script (${js.length} chars)\n${js.replace(/\n\s*\n/g, "\n").slice(0, 6_000)}`);
}

// 2. Scripts, resolved against <base>, searched for the calls they make.
const srcs = [...home.body.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => new URL(m[1], homeBase).href)
  .filter((s) => /dticket\.railway\.co\.th/.test(s) && !/jquery-|bootstrap|popper|all\.min|owl|scroll|select2|mask|datepicker/i.test(s));
console.log(`\n# Scripts (${srcs.length} first-party, libraries skipped)`);
for (const src of srcs.slice(0, 8)) {
  const js = await request(src, { accept: "*/*" });
  if (!describe(src, js)) continue;
  save(src, js.body);
  const calls = [...new Set([...js.body.matchAll(/["'`]([A-Za-z0-9_\-./]*(?:booking|search|station|train|fare|price|seat|api|get)[A-Za-z0-9_\-./]*)["'`]/gi)].map((m) => m[1]))];
  console.log(`call-ish strings (${calls.length}): ${calls.slice(0, 150).join("  ")}`);
  for (const m of js.body.matchAll(/.{0,120}\$\.(?:ajax|post|get)\s*\([\s\S]{0,300}/g)) console.log(`  ajax: ${m[0].replace(/\s+/g, " ")}`);
}

// 3. The station list the form fills itself with (POST home/Home/getStation,
// JSON), then one search per sample corridor with the ids it gives, then the
// calls the results page makes to fill itself in.
const ajax = async (relative, form, label = relative) => {
  const res = await request(new URL(relative, homeBase).href, {
    method: "POST",
    form,
    accept: "application/json, text/javascript, */*; q=0.01",
    referer: HOME,
  });
  if (!describe(`POST ${relative} ${label === relative ? "" : label}`, res)) return null;
  save(`ajax-${relative}-${label}`, res.body);
  try {
    return JSON.parse(res.body);
  } catch {
    console.log(`  not JSON: ${res.body.slice(0, 400).replace(/\s+/g, " ")}`);
    return null;
  }
};

const stationsAnswer = await ajax("home/Home/getStation", { LineId: "" });
const stationList = Array.isArray(stationsAnswer?.data) ? stationsAnswer.data : [];
console.log(`  errorCode ${stationsAnswer?.errorCode}, ${stationList.length} stations; keys ${JSON.stringify(Object.keys(stationList[0] ?? {}))}`);
for (const st of stationList.slice(0, 5)) {
  console.log(`    ${st.stationId}\t${st.stationNo}\t${st.stationNameTh}\t${st.stationNameEn}`);
}
const idFor = (name) => stationList.find((s) => String(s.stationNameEn).trim() === name)?.stationId ?? null;

const travel = new Date(Date.now() + 10 * 86_400_000);
const dd = String(travel.getUTCDate()).padStart(2, "0");
const mm = String(travel.getUTCMonth() + 1).padStart(2, "0");
const yyyy = travel.getUTCFullYear();
const formAction = new URL("booking/booking", homeBase).href;
console.log(`\n# Searches → ${formAction}`);
for (const [from, to] of SAMPLES) {
  const start = idFor(from);
  const end = idFor(to);
  console.log(`\n${from} (${start}) → ${to} (${end}), ${dd}/${mm}/${yyyy}`);
  if (!start || !end) { console.log("  station not in getStation's list — skipped"); continue; }
  const form = {
    tripType: "1",
    provinceStart: String(start),
    provinceEnd: String(end),
    "date-start-picker": `${dd}/${mm}/${yyyy}`,
    "date-start": `${dd}/${mm}/${yyyy}`,
    "date-end-picker": "",
    "date-end": "",
    seatperson: "1",
    lineId: "0",
  };
  const res = await request(formAction, { method: "POST", form, referer: HOME });
  if (!describe(`POST booking/booking ${from}→${to}`, res)) continue;
  save(`search-${from}-${to}`, res.body);
  let page = res;
  if (res.location) {
    page = await request(new URL(res.location, formAction).href, { referer: HOME });
    if (!describe(`redirect → ${res.location}`, page)) continue;
    save(`search-${from}-${to}-redirect`, page.body);
  }
  const calls = [...new Set([...page.body.matchAll(/(?:SmartUtil\.ajax|DTUtil\.\w+|url\s*:)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
  console.log(`  calls the page makes: ${calls.join("  ")}`);
  console.log(`  hidden inputs: ${inputsOf(page.body).filter((i) => /hidden/i.test(i)).slice(0, 40).join(" | ")}`);
  for (const m of page.body.matchAll(/<script\b(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (/SmartUtil\.ajax|search|train|fare|price/i.test(m[1]) && !/getNotifications|getTripGroup|getNewsInfo/.test(m[1])) {
      console.log(`  --- inline script (${m[1].length} chars)\n${m[1].replace(/\n\s*\n/g, "\n").slice(0, 9_000)}`);
    }
  }
  dumps.push([`search ${from}→${to}`, page.body]);
  // The whole results page, once, between markers: the trip list is built by
  // code this probe has not found by pattern, so read it whole offline.
  console.log(`\n<<<RESULTS-PAGE ${page.body.length}\n${page.body}\n>>>RESULTS-PAGE`);

  // The results page fills itself from an external script (showTrips). Find
  // it and every call it makes, with the context around showTrips.
  if (from === SAMPLES[0][0]) {
    const pageBase = base(page.body, formAction);
    const allSrcs = [...page.body.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => new URL(m[1], pageBase).href);
    console.log(`  all results-page script srcs:\n    ${allSrcs.join("\n    ")}`);
    const pageSrcs = allSrcs.filter((u) => /dticket\.railway\.co\.th/.test(u) && !/jquery-|bootstrap\.|popper|all\.min|owl\.|scrollReveal|scrollreveal|select2|jquery\.mask|datepicker|SmartUtil|RecaptchaHelper|assets\/js\/common\.js|assets\/js\/script\.js|DTUtil|LangLoader/i.test(u));
    // Inline scripts that define or carry showTrips.
    for (const m of page.body.matchAll(/<script\b(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const js = m[1];
      const at = js.search(/showTrips\s*(?:=|\()\s*(?:function|\(|async|[a-z])/);
      const def = js.search(/(?:function\s+showTrips|showTrips\s*=)/);
      if (def >= 0) console.log(`  --- inline showTrips definition\n${js.slice(def, def + 9000)}`);
      else if (at >= 0 && /SmartUtil\.ajax/.test(js)) console.log(`  (inline script ${js.length} chars calls showTrips and ajax)`);
    }
    for (const src of pageSrcs.slice(0, 8)) {
      const js = await request(src, { accept: "*/*", referer: formAction });
      if (!describe(src, js)) continue;
      save(src, js.body);
      const calls = [...new Set([...js.body.matchAll(/(?:SmartUtil\.ajax|DTUtil\.\w+|url\s*:)\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]))];
      console.log(`  calls: ${calls.join("  ")}`);
      for (const m of js.body.matchAll(/function\s+showTrips[\s\S]{0,6000}/g)) console.log(`  --- showTrips\n${m[0]}`);
      for (const m of js.body.matchAll(/SmartUtil\.ajax\(\s*['"`][^'"`]*(?:trip|train|fare|seat|search|coach)[^'"`]*['"`][\s\S]{0,1500}/gi)) console.log(`  --- ajax\n${m[0]}`);
    }
  }
}

// The captcha helper in full: which actions it guards.
const helper = await request(new URL("assets/js/RecaptchaHelper.js", homeBase).href, { accept: "*/*" });
if (describe("RecaptchaHelper.js", helper)) console.log(helper.body.slice(0, 4_000));

console.log(`\n# Requests: ${requests}; blocked hosts: ${[...blockedHosts].join(", ") || "none"}`);
console.log(`\n# Page text (capped at ${MAX_TEXT_LOG} chars each)`);
for (const [label, body] of dumps) console.log(`\n## ${label}\n${textOf(body).slice(0, MAX_TEXT_LOG)}`);
