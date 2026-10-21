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
// Run: node scripts/probe-vnr.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const outDir = process.argv[2] ?? null;
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
      const href = new URL(m[1], base).href;
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
