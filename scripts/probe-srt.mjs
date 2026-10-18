// scripts/probe-srt.mjs
// What State Railway of Thailand's own hosts serve to an automated client,
// printed to the job log.
//
// The dev sandbox cannot reach railway.co.th, dticket.railway.co.th or
// ttsview.railway.co.th, so this is how we learn what is there before writing
// a reader for it. It is a discovery crawl, bounded and read-only: each seed
// page, then same-host links whose address or text mentions a timetable, a
// fare or a train, then the scripts those pages load (searched for API paths).
// Per page it prints the status, content type, title, forms and the links it
// found; the API-looking strings from scripts; and finally a capped text dump
// of every page, LAST, so the tail of the log is the raw material.
//
// Read-only: GET requests only, an honest User-Agent, at most MAX_REQUESTS.
// A block (detectBlock) stops asking that host.
// Run: node scripts/probe-srt.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "./lib/http-block.mjs";

const outDir = process.argv[2] ?? null;
const MAX_REQUESTS = 70;
const MAX_TEXT_LOG = 6_000;
const SPACING_MS = 700;

const SEEDS = [
  "https://www.railway.co.th/",
  "https://www.railway.co.th/Checktime",
  "https://www.railway.co.th/Station/StationList",
  "https://www.railway.co.th/Home/Index?lang=en",
  "https://dticket.railway.co.th/",
  "https://dticket.railway.co.th/DTicketPublicWeb/home/Home",
  "https://ttsview.railway.co.th/",
  "https://ttsview.railway.co.th/v3/",
  "https://namtang.otp.go.th/",
  "https://namtang-api.otp.go.th/download/namtang-gtfs.zip",
];

const INTERESTING = /timetable|checktime|time.?table|schedule|fare|price|train|trip|route|station|search|ตาราง|เวลา|ค่าโดยสาร|ขบวน|api/i;
const API_STRING = /["'`]((?:https?:\/\/[^"'`\s]{4,200})|(?:\/[A-Za-z0-9_\-./]{2,160}))["'`]/g;
const API_HINT = /api|train|time|fare|price|station|schedule|search|route|trip|seat|ticket/i;

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
      headers: { "User-Agent": HONEST_USER_AGENT, Accept: "text/html,application/json,*/*;q=0.8", "Accept-Language": "en,th;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const type = res.headers.get("content-type") ?? "";
    const isBinary = /zip|octet-stream|pdf|image/i.test(type);
    let body = "";
    let bytes = 0;
    if (isBinary) {
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.length;
    } else {
      body = await res.text();
      bytes = body.length;
    }
    const block = detectBlock({ status: res.status, headers: res.headers, body });
    if (block) blockedHosts.add(host);
    const headers = {};
    for (const k of ["server", "content-type", "content-length", "last-modified", "cf-ray", "set-cookie", "x-powered-by"]) {
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
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
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

console.log(`# SRT discovery probe — ${new Date().toISOString()}\n`);

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
    for (const l of interesting) {
      if (new URL(l.href).host !== host) continue;
      if (/\.(pdf|jpg|png|zip)$/i.test(l.href)) { console.log(`  (file) ${l.href}`); continue; }
      queue.push({ url: l.href, depth: depth + 1 });
    }
  }
  // API-looking strings inline in the page itself.
  const inline = [...new Set([...page.body.matchAll(API_STRING)].map((m) => m[1]).filter((s) => API_HINT.test(s)))];
  if (inline.length) console.log(`inline api-ish strings (${inline.length}): ${inline.slice(0, 80).join("  ")}`);
}

console.log(`\n# Scripts (${scripts.size})`);
for (const src of [...scripts].filter((s) => /railway\.co\.th|otp\.go\.th/.test(s)).slice(0, 15)) {
  const page = await get(src);
  console.log(`\n## ${src}\n${page.status ?? page.error ?? page.skipped} ${page.bytes ?? 0} bytes`);
  if (!page.body) continue;
  save(src, page.body);
  const found = [...new Set([...page.body.matchAll(API_STRING)].map((m) => m[1]).filter((s) => API_HINT.test(s)))];
  console.log(`api-ish strings (${found.length}): ${found.slice(0, 120).join("  ")}`);
}

console.log(`\n# Requests: ${requests}; blocked hosts: ${[...blockedHosts].join(", ") || "none"}`);

console.log(`\n# Page text (capped at ${MAX_TEXT_LOG} chars each)`);
for (const page of pages) {
  if (!page.body || /javascript/.test(page.type ?? "")) continue;
  console.log(`\n## ${page.url}\n${textOf(page.body).slice(0, MAX_TEXT_LOG)}`);
}
