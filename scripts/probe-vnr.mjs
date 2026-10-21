// scripts/probe-vnr.mjs
// What Vietnam Railways' own hosts serve to an automated client, printed to
// the job log.
//
// The dev sandbox cannot reach dsvn.vn (the official ticket shop),
// k.vnticketonline.vn (its "Thông tin hành trình" journey-information app,
// which is where the timetable the `vnr` source reads was originally taken
// from) or giotaugiave.dsvn.vn ("Thông tin giờ tàu giá vé", times and fares),
// so this is how we learn what is there before writing a fare reader for it.
// It is a discovery crawl, bounded and read-only: each seed page, then
// same-host links whose address or text mentions a timetable, a fare or a
// train, then the scripts those pages load — single-page apps keep their API
// paths there, so each script is searched for API-looking strings and for the
// Vietnamese names VNR's APIs have used (SearchTau…, GaDi/GaDen, GiaVe,
// HanhTrinh, ToaXe, Cho). Per page it prints the status, content type, title,
// forms and the links it found; and finally a capped text dump of every page,
// LAST, so the tail of the log is the raw material.
//
// Read-only: GET requests only, an honest User-Agent, at most MAX_REQUESTS.
// A block (detectBlock) stops asking that host.
// Run: node scripts/probe-vnr.mjs [outputDir] [--crawl | --forms]
//   default   what the `vnr` adapter reads: every line's trains, each night
//             train's fares, and raw answers for tests/fixtures/vnr
//   --forms   every giotaugiave form field and one search per direction
//   --crawl   the first discovery crawl of VNR's hosts

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--")) ?? null;
const CRAWL = args.includes("--crawl");
const FORMS = args.includes("--forms");
const MAX_REQUESTS = 80;
const MAX_TEXT_LOG = 5_000;
const SPACING_MS = 700;
const MAX_SCRIPT_BYTES = 8_000_000;

const SEEDS = [
  "https://dsvn.vn/",
  "https://k.vnticketonline.vn/",
  "https://giotaugiave.dsvn.vn/",
  "https://vr.com.vn/",
  "https://cophanvantaiduongsat.vn/cac-tuyen-tau/",
  // The timetable the `vnr` source reads nightly, as a sanity check that the
  // runner reaches it (it is GitHub, so it should).
  "https://raw.githubusercontent.com/elpwc/VietnamRailwayData/main/VNR/timetables/readme.md",
  "https://api.github.com/repos/elpwc/VietnamRailwayData/contents/VNR/timetables",
];

const OWN_HOSTS = /(^|\.)dsvn\.vn$|(^|\.)vnticketonline\.vn$|(^|\.)vr\.com\.vn$|(^|\.)cophanvantaiduongsat\.vn$/;
const INTERESTING = /timetable|schedule|fare|price|train|trip|route|station|search|api|gio-?tau|gia-?ve|hanh-?trinh|lich|tau|ga-|bang-gia|giờ tàu|giá vé|hành trình|lịch trình/i;
const API_STRING = /["'`]((?:https?:\/\/[^"'`\s]{4,200})|(?:\/?[A-Za-z0-9_\-./]{2,160}))["'`]/g;
const API_HINT = /api\/|\/api|service|\.ashx|\.asmx|svc|graphql|json/i;
// The Vietnamese words VNR's API names have been built from (2014's FPT
// shop: SearchTauByGaDiGaDenNgayXP, GetChosByToaXeId) and their likely kin.
const VN_API_WORD = /\b[A-Za-z_]*(?:SearchTau|GaDi|GaDen|GiaVe|GiaTien|HanhTrinh|ToaXe|Chos?By|TauHanh|DanhSachGa|LoadGa|GetGa|GetTau|ThongTin|BangGia|LichTrinh|GioTau|MacTau|DmGa|ListGa|ListTau)[A-Za-z_]*\b/g;

let requests = 0;
const blockedHosts = new Set();
const seen = new Set();
const pages = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (url) => url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_").slice(0, 120);

async function get(url) {
  const host = new URL(url).host;
  if (blockedHosts.has(host)) return { url, skipped: "host blocked earlier" };
  if (requests >= MAX_REQUESTS) return { url, skipped: "request budget spent" };
  requests += 1;
  await sleep(SPACING_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": HONEST_USER_AGENT,
        Accept: "text/html,application/json,application/javascript,*/*;q=0.8",
        "Accept-Language": "en,vi;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const type = res.headers.get("content-type") ?? "";
    const isBinary = /zip|octet-stream|pdf|image|font/i.test(type);
    let body = "";
    let bytes = 0;
    if (isBinary) {
      bytes = Buffer.from(await res.arrayBuffer()).length;
    } else {
      body = await res.text();
      bytes = body.length;
      if (bytes > MAX_SCRIPT_BYTES) body = body.slice(0, MAX_SCRIPT_BYTES);
    }
    const block = detectBlock({ status: res.status, headers: res.headers, body }, { expectJson: false });
    if (block) blockedHosts.add(host);
    const headers = {};
    for (const k of ["server", "content-type", "content-length", "last-modified", "cf-ray", "set-cookie", "x-powered-by", "access-control-allow-origin"]) {
      const v = res.headers.get(k);
      if (v) headers[k] = v.slice(0, 160);
    }
    return { url, finalUrl: res.url, status: res.status, type, bytes, body, block, headers };
  } catch (err) {
    return { url, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

function linksOf(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const href = new URL(m[1].replace(/&amp;/g, "&"), base).href;
      const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      out.push({ href, text });
    } catch {}
  }
  return out;
}

function scriptsOf(html, base) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
    try { out.push(new URL(m[1], base).href); } catch {}
  }
  // Module preloads and lazy chunks an SPA announces in its HTML.
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["'](?:modulepreload|preload)["'][^>]*href\s*=\s*["']([^"']+\.js[^"']*)["']/gi)) {
    try { out.push(new URL(m[1], base).href); } catch {}
  }
  return out;
}

function formsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? "";
    const method = /method\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? "get";
    const inputs = [...m[2].matchAll(/<(?:input|select|textarea)\b[^>]*name\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]);
    out.push({ action, method, inputs: [...new Set(inputs)].slice(0, 30) });
  }
  return out;
}

const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function save(url, body) {
  if (!outDir || !body) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug(url)}.txt`), body);
}

/** API-looking strings in a script, plus every Vietnamese API word with a little context. */
function apiStrings(body) {
  const strings = [...new Set([...body.matchAll(API_STRING)].map((m) => m[1]).filter((s) => API_HINT.test(s) || /^https?:/.test(s)))];
  const words = new Map();
  for (const m of body.matchAll(VN_API_WORD)) {
    if (words.has(m[0])) continue;
    const at = m.index ?? 0;
    words.set(m[0], body.slice(Math.max(0, at - 120), at + 160).replace(/\s+/g, " "));
  }
  return { strings, words };
}

async function crawl() {
  console.log(`# VNR discovery probe — ${new Date().toISOString()}\n`);

  const queue = SEEDS.map((url) => ({ url, depth: 0 }));
  const scripts = new Set();

  while (queue.length && requests < MAX_REQUESTS) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const page = await get(url);
    pages.push(page);
    save(url, page.body);
    console.log(`\n## ${url}`);
    if (page.skipped) { console.log(`skipped: ${page.skipped}`); continue; }
    if (page.error) { console.log(`error: ${page.error}`); continue; }
    console.log(`status ${page.status}${page.finalUrl && page.finalUrl !== url ? ` → ${page.finalUrl}` : ""}, ${page.type}, ${page.bytes} bytes`);
    console.log(`headers ${JSON.stringify(page.headers)}`);
    if (page.block) console.log(`BLOCKED ${JSON.stringify(page.block)}`);
    if (!page.body) continue;
    if (/json/.test(page.type)) {
      console.log(`json: ${page.body.slice(0, 3_000)}`);
      continue;
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.body)?.[1]?.trim();
    if (title) console.log(`title: ${title.slice(0, 160)}`);
    const forms = formsOf(page.body);
    if (forms.length) console.log(`forms: ${JSON.stringify(forms)}`);
    const base = page.finalUrl || url;
    const links = linksOf(page.body, base);
    const interesting = links.filter((l) => INTERESTING.test(l.href) || INTERESTING.test(l.text));
    console.log(`links: ${links.length}, interesting ${interesting.length}`);
    for (const l of interesting.slice(0, 60)) console.log(`  - ${l.href}  [${l.text}]`);
    for (const s of scriptsOf(page.body, base)) scripts.add(s);
    if (depth < 1) {
      const host = new URL(base).host;
      for (const l of interesting.slice(0, 12)) {
        if (new URL(l.href).host !== host) continue;
        if (/\.(pdf|jpg|png|zip|xlsx?)$/i.test(l.href)) { console.log(`  (file) ${l.href}`); continue; }
        queue.push({ url: l.href, depth: depth + 1 });
      }
    }
    const { strings, words } = apiStrings(page.body);
    if (strings.length) console.log(`inline api-ish strings (${strings.length}): ${strings.slice(0, 80).join("  ")}`);
    for (const [w, ctx] of words) console.log(`  vn-word ${w}: …${ctx}…`);
  }

  console.log(`\n# Scripts (${scripts.size})`);
  for (const src of [...scripts].filter((s) => OWN_HOSTS.test(new URL(s).host)).slice(0, 25)) {
    const page = await get(src);
    console.log(`\n## ${src}\n${page.status ?? page.error ?? page.skipped} ${page.bytes ?? 0} bytes`);
    if (!page.body) continue;
    save(src, page.body);
    const { strings, words } = apiStrings(page.body);
    console.log(`api-ish strings (${strings.length}): ${strings.slice(0, 150).join("  ")}`);
    for (const [w, ctx] of [...words].slice(0, 80)) console.log(`  vn-word ${w}: …${ctx}…`);
    // Lazy chunks an SPA loads by name from its runtime.
    const chunks = [...new Set([...page.body.matchAll(/["'`]([\w.-]*(?:chunk|main|app|runtime)[\w.-]*\.js)["'`]/g)].map((m) => m[1]))];
    if (chunks.length) console.log(`chunk names: ${chunks.slice(0, 60).join("  ")}`);
  }

  console.log(`\n# Requests: ${requests}; blocked hosts: ${[...blockedHosts].join(", ") || "none"}`);

  console.log(`\n# Page text (capped at ${MAX_TEXT_LOG} chars each)`);
  for (const page of pages) {
    if (!page.body || /javascript|json/.test(page.type ?? "")) continue;
    console.log(`\n## ${page.url}\n${textOf(page.body).slice(0, MAX_TEXT_LOG)}`);
  }
}

// ─── giotaugiave.dsvn.vn: the official times-and-fares site ─────────────────
//
// The first crawl (2026-10-21) found it: an ASP.NET WebForms site, no captcha,
// one form per page — giotau/* for times, giave/* for fares, thongnhat.aspx
// for the north–south trains and diaphuong.aspx?option=&tuyen= per regional
// line. Each form is a postback (__VIEWSTATE, __EVENTVALIDATION) over
// txtNgayDi (date), ddlChieu (direction), ddlMacTau (train), ddlGaDi/ddlGaDen
// (stations) and btnTraTim (search). This prints every field and option, then
// the answer to one search with the defaults and one in the other direction.

const GTGV = "https://giotaugiave.dsvn.vn/";
const FORM_PAGES = [
  "giotau/thongnhat.aspx",
  "giave/thongnhat.aspx",
  "giotau/diaphuong.aspx?option=2&tuyen=5",
  "giave/diaphuong.aspx?option=2&tuyen=5",
  "giotau/diaphuong.aspx?option=2&tuyen=1",
  "giotau/diaphuong.aspx?option=3&tuyen=1",
  "giave/diaphuong.aspx?option=3&tuyen=1",
  "giotau/diaphuong.aspx?option=2&tuyen=3",
];

const decode = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
const attr = (tag, name) => decode(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "");

/** The page's main form: hidden/text/submit inputs and selects with their options. */
export function parseAspForm(html) {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html)?.[1] ?? "";
  const inputs = [];
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    inputs.push({ type: attr(m[0], "type") || "text", name: attr(m[0], "name"), value: attr(m[0], "value") });
  }
  const selects = [];
  for (const m of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
      value: attr(o[1], "value"),
      text: decode(o[2].replace(/<[^>]+>/g, "")).trim(),
      selected: /\bselected\b/i.test(o[1]),
    }));
    selects.push({ name: attr(m[1], "name"), onchange: attr(m[1], "onchange"), options });
  }
  return { inputs, selects };
}

/** Every table in the page as rows of cell texts (nested tables flattened). */
export function tablesOf(html) {
  const out = [];
  for (const t of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(c[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()),
    );
    if (rows.length) out.push(rows);
  }
  return out;
}

function makeSession() {
  const cookies = new Map();
  return async function call(url, { form = null } = {}) {
    if (requests >= MAX_REQUESTS) throw new Error("request budget spent");
    requests += 1;
    await sleep(SPACING_MS);
    const headers = { "User-Agent": HONEST_USER_AGENT, Accept: "text/html,*/*;q=0.8", "Accept-Language": "vi,en;q=0.8", Referer: url };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(url, { method: form ? "POST" : "GET", headers, body, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    for (const line of typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson: false });
    if (block) throw new Error(`blocked: ${JSON.stringify(block)}`);
    return { status: res.status, text };
  };
}

/** Field values the browser would post: hidden inputs + each select's selected (or first) option. */
function postbackFields(parsed, overrides = {}) {
  const fields = {};
  for (const i of parsed.inputs) {
    if (!i.name) continue;
    if (i.type === "hidden") fields[i.name] = i.value;
    if (i.type === "text" && /txtNgay/i.test(i.name)) fields[i.name] = i.value;
  }
  for (const s of parsed.selects) {
    if (!s.name || /Login/.test(s.name)) continue;
    fields[s.name] = (s.options.find((o) => o.selected) ?? s.options[0])?.value ?? "";
  }
  return { ...fields, ...overrides };
}

function describeForm(parsed) {
  for (const i of parsed.inputs) {
    if (/Login/.test(i.name)) continue;
    const v = i.type === "hidden" ? `${i.value.length} chars` : JSON.stringify(i.value);
    console.log(`  input ${i.type} ${i.name} = ${v}`);
  }
  for (const s of parsed.selects) {
    console.log(`  select ${s.name}${s.onchange ? ` onchange=${JSON.stringify(s.onchange.slice(0, 160))}` : ""} (${s.options.length} options)`);
    console.log(`    ${s.options.slice(0, 80).map((o) => `${o.selected ? "*" : ""}${o.value}=${o.text}`).join(" | ")}`);
  }
}

function printAnswer(label, html) {
  const tables = tablesOf(html)
    .map((rows) => rows.filter((r) => r.some((c) => c)))
    .filter((rows) => rows.length >= 2 && rows.some((r) => r.some((c) => /\d{1,2}[:h]\d{2}|\d{1,3}[.,]\d{3}/.test(c))));
  console.log(`  ${label}: ${tables.length} table(s) with times or prices`);
  for (const rows of tables.slice(0, 4)) {
    console.log(`  ┌ ${rows.length} rows`);
    for (const r of rows.slice(0, 70)) console.log(`  │ ${r.join(" | ").slice(0, 400)}`);
  }
  if (!tables.length) {
    const msg = textOf(html).replace(/^[\s\S]*?(Tra tìm|Giờ tàu Ngày đi|Ngày đi)/, "$1").slice(0, 2_500);
    console.log(`  text: ${msg}`);
  }
}

async function formsProbe() {
  console.log(`# giotaugiave.dsvn.vn forms — ${new Date().toISOString()}`);
  for (const rel of FORM_PAGES) {
    const url = new URL(rel, GTGV).href;
    const call = makeSession();
    console.log(`\n## ${url}`);
    try {
      const first = await call(url);
      save(url, first.text);
      const parsed = parseAspForm(first.text);
      console.log(`status ${first.status}`);
      describeForm(parsed);
      const button = parsed.inputs.find((i) => i.type === "submit" && /btnTraTim/i.test(i.name));
      if (!button) {
        console.log("  no btnTraTim — not a search form");
        continue;
      }
      const fields = postbackFields(parsed, { [button.name]: button.value });
      const answer = await call(url, { form: fields });
      save(`${url}#search`, answer.text);
      console.log(`  POST defaults (${Object.entries(fields).filter(([k]) => !k.startsWith("__")).map(([k, v]) => `${k.split("$").pop()}=${v}`).join(", ")}) → ${answer.status}`);
      printAnswer("answer", answer.text);
      // The other direction: switch ddlChieu, letting the page repopulate the
      // trains and stations if the select posts back on change.
      const chieu = parsed.selects.find((s) => /ddlChieu/i.test(s.name));
      const other = chieu?.options.find((o) => !o.selected);
      if (chieu && other) {
        let page = parseAspForm(answer.text);
        if (/__doPostBack/.test(chieu.onchange)) {
          const changed = await call(url, { form: postbackFields(page, { __EVENTTARGET: chieu.name, __EVENTARGUMENT: "", [chieu.name]: other.value }) });
          page = parseAspForm(changed.text);
          console.log(`  after choosing ${other.text}:`);
          describeForm({ inputs: [], selects: page.selects.filter((s) => !/Login/.test(s.name)) });
        }
        const back = await call(url, { form: postbackFields(page, { [chieu.name]: other.value, [button.name]: button.value }) });
        save(`${url}#search-back`, back.text);
        printAnswer(`answer, ${other.text}`, back.text);
      }
    } catch (err) {
      console.log(`  error: ${err.message}`);
    }
  }
  console.log(`\n# Requests: ${requests}`);
}

// ─── What the adapter reads ─────────────────────────────────────────────────

async function readerProbe() {
  const { readTimetables, readFares, makeSession } = await import("./adapters/vnr.mjs");
  const { isNightTrain, journeyMinutes, nightsOf, makeStationNamer, berthClass } = await import("./lib/vnr.mjs");
  const registry = JSON.parse(fs.readFileSync(new URL("../data/sources/registry.json", import.meta.url), "utf8"));
  const entry = registry.find((e) => e.id === "vnr");
  const config = JSON.parse(fs.readFileSync(new URL(`../${entry.params.configPath}`, import.meta.url), "utf8"));
  const travel = new Date(Date.now() + (entry.params.dateOffsetDays ?? 7) * 86_400_000).toISOString().slice(0, 10);
  const date = `${travel.slice(8, 10)}-${travel.slice(5, 7)}-${travel.slice(0, 4)}`;
  console.log(`# What the vnr adapter reads — ${new Date().toISOString()}, travel ${date}\n`);
  // Keep a few raw answers, trimmed, for tests/fixtures/vnr.
  const fixtures = new Map();
  const counter = { requests: 0, blocked: null };
  const inner = makeSession({ counter, log: console.log });
  const call = async (url, form) => {
    const text = await inner(url, form);
    const train = form && Object.entries(form).find(([k]) => k.endsWith("ddlMacTau"))?.[1];
    const keep = (name) => {
      if (fixtures.has(name)) return;
      fixtures.set(name, text.replace(/(name="__(?:VIEWSTATE|EVENTVALIDATION)"[^>]*value=")[^"]*/g, "$1TRIMMED"));
    };
    if (/giotau\/thongnhat/.test(url) && train === "9175" && /Cự ly/.test(text) && /Sài Gòn/.test(text.slice(text.lastIndexOf("Cự ly")))) keep("giotau-thongnhat-SE1");
    if (/giave\/thongnhat/.test(url) && train === "9175" && /Giá vé/.test(text) && /AnLT1/.test(text)) keep("giave-thongnhat-SE1");
    if (/giotau\/diaphuong\.aspx\?option=2&tuyen=5/.test(url) && !form) keep("giotau-laocai-get");
    if (/giotau\/diaphuong\.aspx\?option=3&tuyen=1/.test(url) && /SNT2/.test(text) && /Nha Trang/.test(text) && /Cự ly/.test(text)) keep("giotau-saigon-return");
    return text;
  };
  const deadline = Date.now() + 20 * 60_000;
  const { trains, failed, complete } = await readTimetables({ base: entry.params.baseUrl, lines: entry.params.lines, date, call, log: console.log, deadline });
  console.log(`\n## ${trains.size} train(s) read; failed: ${[...failed].join(" ") || "none"}; complete: ${complete}`);
  for (const [name, t] of trains) {
    const a = t.tt.stops[0];
    const b = t.tt.stops.at(-1);
    const m = journeyMinutes(t.tt);
    console.log(`  ${isNightTrain(t.tt, config, name) ? "NIGHT" : "     "} ${name.padEnd(6)} ${t.line} (${t.chieu}) ${a.name} ${a.departure} → ${b.name} ${b.arrival} +${nightsOf(t.tt)}  ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}  ${t.tt.stops.length} stops`);
  }
  const night = new Map([...trains].filter(([name, t]) => isNightTrain(t.tt, config, name)));
  const fares = await readFares({ base: entry.params.baseUrl, trains: night, date, call, log: console.log, deadline, namer: makeStationNamer(config.stationNames) });
  console.log(`\n## Fares (${fares.size} of ${night.size} night trains)`);
  for (const [name, f] of fares) {
    console.log(`  ${name}: ${JSON.stringify(f.classes)}`);
    for (const r of f.rows) console.log(`      ${r.code.padEnd(9)} ${String(r.price).padStart(9)}  ${berthClass(r) ?? "-"}  ${r.label}`);
  }
  console.log(`\n# Requests: ${counter.requests}${counter.blocked ? `; BLOCKED ${JSON.stringify(counter.blocked)}` : ""}`);
  for (const [name, html] of fixtures) {
    console.log(`\n-----FIXTURE ${name} (${html.length} chars)-----`);
    console.log(html);
    console.log("-----END FIXTURE-----");
  }
}

if (CRAWL) await crawl();
else if (FORMS) await formsProbe();
else await readerProbe();
