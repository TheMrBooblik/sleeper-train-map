// scripts/probe-nj-fares.mjs
// The Nightjet fare check: is what our fare calendar says about a night what
// nightjet.com says now — and what does ÖBB's shop say? Run from where egress
// is open ("Probe Nightjet fares" workflow: label a PR `run-probes`); the dev
// sandbox reaches neither host, and from there this degrades into a report
// that says so.
//
// It exists because the product owner compared the calendar with
// shop.oebbtickets.at and found figures that did not match, and every
// explanation on offer (stale nights, the grid showing another class, a seat
// price read as a couchette, nightjet.com and the shop disagreeing) was a
// hypothesis nobody had tested. So, in order:
//   1. nightjet.com's robots.txt, printed;
//   2. a sample of stored nights (scripts/lib/nj-fare-check.mjs planSample:
//      the owner's disputed nights, the anomalies, a seeded spread over lead
//      times), each re-asked with the GET the nightly pass makes, read
//      independently of the nightly reader and compared with what we stored;
//   3. the shop step, if data/sources/nj-fare-check.json turns it on: the
//      shop's robots.txt, then its anonymous token — where a block is
//      expected to show — and only on a 200 the timetable and offers for a
//      few of those nights;
//   4. a few of the spread re-asked at the end, to see whether an answer is
//      stable from one minute to the next;
//   5. a fixed-width table and summary on stdout, the same as markdown in
//      $GITHUB_STEP_SUMMARY, and in the output directory a CSV checklist for
//      the owner's side-by-side check in the shop, the raw answers, and
//      results.json.
//
// Every request names itself honestly (http-block.mjs HONEST_USER_AGENT) and
// sends only what the API needs. A block is final: the probe says
// "BLOCKED <host> …", stops asking that host, and keeps the report it has.
// It never retries a refusal, varies its headers, or tries another host —
// this map does not work around an operator's bot protection.
//
// Read-only: GETs and searches, nothing booked, nothing committed.
// Run: node scripts/probe-nj-fares.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildOffersUrl, NJ_BOOKING_BASE, pricingEnds } from "./lib/nj-fares.mjs";
import { describeBlock, detectBlock, HONEST_USER_AGENT } from "./lib/http-block.mjs";
import { fetchWithTimeout } from "./lib/scrape-helpers.mjs";
import {
  ANOMALY_LABELS,
  checklistRecords,
  compareNight,
  disputedVerdict,
  evidenceHeaders,
  extractShopOffers,
  findShopConnection,
  FLAGS,
  fmtPrice,
  formatTable,
  liveNight,
  nightlyReading,
  NJ_ROBOTS_URL,
  normalizeConfig,
  offersBody,
  planSample,
  repeatDifferences,
  robotsDisallowed,
  robotsVerdict,
  SHOP_BASE,
  SHOP_PATHS,
  shopDateTime,
  summarize,
  TABLE_COLUMNS,
  timetableBody,
  toCsv,
  viennaToday,
} from "./lib/nj-fare-check.mjs";

/** After this many network failures in a row a host counts as unreachable. */
const MAX_NETWORK_FAILURES = 3;

const PRICE_SEARCH_PATH = new URL(`${NJ_BOOKING_BASE}/destinations/offers/`).pathname;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s, n = 1500) => {
  const text = String(s ?? "");
  return text.length > n ? `${text.slice(0, n)}… [${text.length - n} more chars]` : text;
};
const oneLine = (s, n = 200) => cap(String(s ?? "").replace(/\s+/g, " ").trim(), n);
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_");

/** The headers that name who refused a request, for a BLOCKED line. */
function vendorLine(headers) {
  const keep = ["server", "via", "cf-ray", "cf-mitigated", "x-azure-ref", "x-msedge-ref"];
  const parts = keep.filter((k) => headers?.[k]).map((k) => `${k}=${headers[k]}`);
  return parts.length ? `[${parts.join(" ")}]` : "[no vendor headers]";
}

/** An HTML page served where robots.txt was asked for (a single-page app's index, say). */
const looksLikePage = (res) => /text\/html/i.test(res.headers?.["content-type"] ?? "") || /^\s*</.test(res.text ?? "");

/** Who served a response, read off its evidence headers the way detectBlock names a vendor. */
function vendorOf(headers) {
  if (headers?.["cf-ray"] || /cloudflare/i.test(headers?.server ?? "")) return "cloudflare";
  if (headers?.["x-azure-ref"] || headers?.["x-msedge-ref"]) return "azure";
  return headers?.server ?? null;
}

/**
 * A price-search answer that is not an answer, in the shape detectBlock
 * returns, or null. detectBlock needs a known block marker before it calls an
 * HTML page a block, which is right for the nightly pass; the check is
 * stricter, because a 2xx that is not JSON — a page, or a redirect that left
 * nightjet.com or went to Cloudflare's /cdn-cgi/ — tells us nothing about a
 * price, and asking again would only ask whatever served it again.
 */
function notAnAnswer(res, text, headers) {
  const vendor = vendorOf(headers);
  if (res.redirected && res.url) {
    let to = null;
    try {
      to = new URL(res.url);
    } catch {
      // An unreadable final URL is judged by the body below.
    }
    if (to && (to.hostname !== new URL(NJ_BOOKING_BASE).hostname || to.pathname.startsWith("/cdn-cgi/"))) {
      return { status: res.status, reason: `redirected to ${res.url}`, vendor };
    }
  }
  if (res.status < 200 || res.status >= 300) return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    const page = /text\/html/i.test(headers?.["content-type"] ?? "") || /^\s*</.test(text);
    return { status: res.status, reason: `${page ? "an HTML page" : "not JSON"} where JSON was asked for`, vendor };
  }
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

/** operator-booking.json's ÖBB entry, whichever way the Ö is composed. */
function obbBooking(booking) {
  const key = Object.keys(booking ?? {}).find((k) => k.normalize("NFC") === "ÖBB".normalize("NFC"));
  return key ? booking[key] : null;
}

/**
 * Run the check. Every effect is injectable so the whole run can be tested
 * offline: `fetchImpl` answers requests, `sleep` waits, `now` is the clock.
 * Resolves the report's data; throws only on a broken input file (a
 * programming or data error), never on what a host answers.
 */
export async function runProbe({
  root = process.cwd(),
  outDir = null,
  fetchImpl = fetchWithTimeout,
  sleep = realSleep,
  now = () => Date.now(),
  log = console.log,
  trainsFile = null,
  config: rawConfig,
  booking = null,
  stepSummary = process.env.GITHUB_STEP_SUMMARY || null,
} = {}) {
  const lines = [];
  const out = (line = "") => {
    lines.push(line);
    log(line);
  };
  const save = (name, body) => {
    if (!outDir) return;
    const file = path.join(outDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  };

  const today = viennaToday(now());
  const file = trainsFile ?? readJson(root, "public/data/scraped/nightjet-trains.json");
  const trains = file?.data?.trains ?? file?.trains ?? {};
  let configSource = "data/sources/nj-fare-check.json";
  if (rawConfig === undefined) {
    try {
      rawConfig = readJson(root, configSource);
    } catch (err) {
      configSource = `defaults (${configSource} unreadable: ${err.message})`;
      rawConfig = {};
    }
  } else {
    configSource = "injected";
  }
  const config = normalizeConfig(rawConfig);
  const obb = obbBooking(booking ?? readJson(root, "data/overrides/operator-booking.json"));
  const template = obb?.journeyUrlTemplate ?? null;
  const dateFormat = obb?.dateFormat ?? "yyyy-MM-dd";

  out(`═══ Nightjet fare check — ${today} (Vienna) — ${NJ_BOOKING_BASE}`);
  out(`User-Agent: ${HONEST_USER_AGENT}`);
  out(`Config: ${configSource}; trains file uploaded ${file?.uploadedAt ?? file?.data?.uploadedAt ?? "?"}`);
  for (const p of config.problems) out(`  config problem: ${p}`);
  if (!template) out("  operator-booking.json has no ÖBB journeyUrlTemplate — the checklist's shop links stay empty");

  // ── The sample ────────────────────────────────────────────────────────────
  const plan = planSample(trains, config, { today });
  const groups = { A: "disputed", B: "anomalies", C: "spread", D: "repeats" };
  out(`\n── Sample (seed "${plan.seed}", at most ${config.maxRequests} requests to nightjet.com, robots.txt included)`);
  for (const [g, label] of Object.entries(groups)) {
    out(`   ${g} ${label.padEnd(9)} ${plan.requests.filter((r) => r.group === g).length} request(s)`);
  }
  out(`   anomalies stored (nights after today): ${Object.entries(plan.anomalyCounts)
    .map(([k, n]) => `${ANOMALY_LABELS[k] ?? k} ${n}`).join(", ")}`);
  if (plan.dropped.length) {
    out(`   the cap dropped ${plan.dropped.length}: ${plan.dropped
      .map((r) => `${r.group} ${r.key} ${r.night} (${r.reasons.join("; ")})`).join(", ")}`);
  } else {
    out("   the cap dropped nothing");
  }
  for (const n of plan.notes) out(`   note: ${n}`);

  // ── nightjet.com ──────────────────────────────────────────────────────────
  const nj = { state: "ok", requests: 0, networkFailures: 0, last: null, block: null, robots: null };
  const spacingMs = config.spacingSeconds * 1000;

  /** One GET to nightjet.com, paced; { skipped } once the host has refused or vanished. */
  async function njGet(url, { expectJson }) {
    if (nj.state !== "ok") return { skipped: `nightjet.com ${nj.state}` };
    if (nj.last != null) await sleep(Math.max(0, spacingMs - (now() - nj.last)));
    nj.requests++;
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        headers: { accept: expectJson ? "application/json" : "text/plain", "user-agent": HONEST_USER_AGENT },
      });
      text = await res.text();
    } catch (err) {
      nj.last = now();
      nj.networkFailures++;
      const reason = err.cause?.code ?? err.message;
      if (nj.networkFailures >= MAX_NETWORK_FAILURES) {
        nj.state = "unreachable";
        out(`UNREACHABLE nightjet.com — ${nj.networkFailures} network failures in a row (last: ${reason}); not asking it again this run`);
      }
      return { error: `network: ${reason}` };
    }
    nj.last = now();
    nj.networkFailures = 0;
    const headers = evidenceHeaders(res.headers);
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson })
      ?? (expectJson ? notAnAnswer(res, text, headers) : null);
    if (block) {
      nj.state = "blocked";
      nj.block = { status: res.status, reason: describeBlock(block), headers };
      out(`BLOCKED nightjet.com ${res.status} ${vendorLine(headers)} ${oneLine(text)} — ${describeBlock(block)}; not asking it again this run`);
    }
    return { status: res.status, ok: res.ok, headers, text, block, redirectedTo: res.redirected ? res.url : null };
  }

  out(`\n── nightjet.com robots.txt`);
  const robots = await njGet(NJ_ROBOTS_URL, { expectJson: false });
  if (robots.error) out(`   ${robots.error}`);
  else if (robots.block) out("   (blocked — see above)");
  else if (robots.status === 404 || robots.status === 410) {
    nj.robots = "none";
    out(`   HTTP ${robots.status}: no robots.txt, so no rules`);
  } else if (!robots.ok) {
    out(`   HTTP ${robots.status}: ${oneLine(robots.text)}`);
  } else {
    save("robots-nightjet.txt", robots.text);
    out(cap(robots.text, 2000).split("\n").map((l) => `   | ${l}`).join("\n"));
    if (looksLikePage(robots)) out("   (a page, not rules: RFC 9309 reads lines it cannot parse as no rules)");
    const v = robotsVerdict(robots.text, PRICE_SEARCH_PATH, "*");
    nj.robots = v.allowed ? "allows" : "disallows";
    out(v.allowed
      ? `   robots.txt allows the price search (${PRICE_SEARCH_PATH}) for *${v.rule ? ` (Allow: ${v.rule.path})` : ""}`
      : `   NOTE robots.txt DISALLOWS the price search (${PRICE_SEARCH_PATH}) for * (Disallow: ${v.rule.path}) — the nightly pass reads this path; the owner should know`);
  }

  const rows = [];
  const rowById = new Map();

  async function askNight(request) {
    const ends = pricingEnds(trains[request.key]);
    const url = buildOffersUrl({ trainName: request.key, fromId: ends.fromId, toId: ends.toId, date: request.night });
    const row = { request, stored: plan.stored[request.id], ends, url };
    const res = await njGet(url, { expectJson: true });
    if (res.skipped) row.skipped = res.skipped;
    else if (res.error) row.error = res.error;
    else {
      row.askedAt = now();
      row.status = res.status;
      row.headers = res.headers;
      if (res.redirectedTo) row.redirectedTo = res.redirectedTo;
      const suffix = request.group === "D" ? "-repeat" : "";
      save(`raw/nightjet-${String(request.id).padStart(2, "0")}-${safeName(request.key)}-${request.night}${suffix}.json`, res.text);
      if (res.block) row.error = `BLOCKED ${describeBlock(res.block)}`;
      else if (!res.ok) row.error = `HTTP ${res.status} ${oneLine(res.text, 80)}`;
      else {
        let body;
        try {
          body = JSON.parse(res.text);
        } catch {
          row.error = `not JSON (${res.text.length} bytes): ${oneLine(res.text, 80)}`;
        }
        if (body !== undefined) {
          row.live = liveNight(body, request.night);
          row.reader = nightlyReading(body, request.night);
        }
      }
    }
    row.comparison = compareNight({
      key: request.key, night: request.night, stored: row.stored, live: row.live, today,
      partnerTrains: config.partnerTrains, reader: row.reader,
    });
    if (row.error) row.comparison.flags.push(FLAGS.error);
    rows.push(row);
    rowById.set(request.id, row);
    return row;
  }

  out(`\n── Asking nightjet.com (${spacingMs / 1000} s apart)`);
  for (const request of plan.requests.filter((r) => r.group !== "D")) {
    const row = await askNight(request);
    if (!row.skipped) {
      const what = row.error ?? (row.live.status === "priced"
        ? `le ${fmtPrice(row.live.le?.price ?? null)} be ${fmtPrice(row.live.be?.price ?? null)} se ${fmtPrice(row.live.se?.price ?? null)}`
        : `${row.live.status}${row.live.reason ? `:${row.live.reason}` : ""}${row.live.note ? ` (${row.live.note})` : ""}`);
      out(`   #${request.id} ${request.key} ${request.night}: ${what}`);
    }
  }
  const skippedCount = rows.filter((r) => r.skipped).length;
  if (skippedCount) out(`   ${skippedCount} night(s) not asked: nightjet.com ${nj.state}`);

  // ── The shop ──────────────────────────────────────────────────────────────
  let shop = { state: "disabled", requests: 0, apiRequests: 0, results: [], notes: [] };
  if (config.shop.enabled) {
    out(`\n── shop.oebbtickets.at (${config.shop.spacingSeconds} s apart, at most ${config.shop.maxTrainNights} train-night(s))`);
    try {
      shop = await runShopStep({ rows, config, fetchImpl, sleep, now, out, save });
    } catch (err) {
      // The shop step is an experiment beside the report; nothing it meets may cost the report.
      shop.state = "error";
      shop.notes.push(`unexpected error: ${err.stack ?? err.message}`);
      out(`   shop step stopped on an unexpected error (${err.message}) — the nightjet.com report is unaffected`);
    }
  } else {
    out("\n── shop.oebbtickets.at: off (data/sources/nj-fare-check.json shop.enabled)");
  }

  // ── Repeats ───────────────────────────────────────────────────────────────
  const repeats = plan.requests.filter((r) => r.group === "D");
  if (repeats.length) {
    out(`\n── Repeats (${repeats.length})`);
    const firstAsked = repeats.map((r) => rowById.get(r.repeatOf)?.askedAt).filter((t) => t != null);
    if (nj.state === "ok" && firstAsked.length) {
      const wait = Math.max(...firstAsked) + config.repeatMinGapSeconds * 1000 - now();
      if (wait > 0) {
        out(`   waiting ${Math.ceil(wait / 1000)} s so each repeat comes at least ${config.repeatMinGapSeconds} s after its first ask`);
        await sleep(wait);
      }
    }
    for (const request of repeats) {
      const original = rowById.get(request.repeatOf);
      if (!original?.live) {
        const stored = plan.stored[request.id];
        rows.push({
          request, stored, ends: original?.ends, url: original?.url, skipped: "the first ask had no answer",
          comparison: compareNight({ key: request.key, night: request.night, stored, live: null, today }),
        });
        continue;
      }
      const row = await askNight(request);
      if (!row.live) continue;
      const differences = repeatDifferences(original.live, row.live);
      row.repeat = {
        differences,
        gapSeconds: original.askedAt != null && row.askedAt != null ? Math.round((row.askedAt - original.askedAt) / 1000) : null,
        etagSame: original.headers?.etag && row.headers?.etag ? original.headers.etag === row.headers.etag : null,
      };
      if (differences.length) {
        row.comparison.flags.push(FLAGS.repeatDiff);
        original.comparison.flags.push(FLAGS.repeatDiff);
      }
      out(`   #${request.id} = #${request.repeatOf} ${request.key} ${request.night} after ${row.repeat.gapSeconds ?? "?"} s: ${differences.length ? `DIFFERENT — ${differences.join("; ")}` : "same answer"}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  rows.sort((a, b) => a.request.id - b.request.id);
  // The owner's own figure against ours and nightjet.com's, before the
  // summary counts flags.
  for (const row of rows) {
    if (row.request.group === "D" || !row.request.reasons.includes("disputed")) continue;
    const d = config.disputed.find((x) => x.train === row.request.key && x.date === row.request.night);
    row.disputed = { ...d, verdict: disputedVerdict(d?.shop, row.stored, row.live) };
    if (row.disputed.verdict.matchesLive === false) row.comparison.flags.push(FLAGS.shopDiff);
  }
  const summary = summarize(rows);
  const report = buildReport({ today, config, plan, rows, summary, nj, shop });
  out("");
  for (const line of report.text) out(line);

  save("report.md", report.markdown);
  save("nj-fare-checklist.csv", toCsv(checklistRecords(rows, { template, dateFormat })));
  save("results.json", {
    today, seed: plan.seed, userAgent: HONEST_USER_AGENT, config, nightjet: nj, plan: {
      requests: plan.requests, dropped: plan.dropped, notes: plan.notes, anomalyCounts: plan.anomalyCounts,
    },
    rows: rows.map(({ reader, ...r }) => r),
    summary,
    shop,
  });
  save("probe-nj-fares.log", `${lines.join("\n")}\n`);
  if (stepSummary) {
    try {
      fs.appendFileSync(stepSummary, report.markdown);
    } catch (err) {
      log(`(could not write the step summary: ${err.message})`);
    }
  }
  return { today, plan, rows, summary, nightjet: nj, shop, report };
}

// ── The shop step ───────────────────────────────────────────────────────────

/**
 * shop.oebbtickets.at, asked the way its own pages ask it but as ourselves:
 * robots.txt, an anonymous token, the session, then per train-night the
 * timetable and the offers. Only functional headers — Accept, Content-Type,
 * Channel, AccessToken — and the honest User-Agent: no support id, client
 * id, Origin, Referer, Sec-Fetch or browser identity, which would be the
 * shop's own web client impersonated. Anything that refuses ends the step.
 */
async function runShopStep({ rows, config, fetchImpl, sleep, now, out, save }) {
  const shop = { state: "ok", requests: 0, apiRequests: 0, results: [], notes: [], robots: null };
  const spacingMs = config.shop.spacingSeconds * 1000;
  let last = null;

  const end = (state, line) => {
    shop.state = state;
    out(line.startsWith("BLOCKED") ? line : `   ${line}`);
    return shop;
  };

  async function shopFetch(pathName, { method = "GET", body, token = null, expectJson = true }) {
    if (last != null) await sleep(Math.max(0, spacingMs - (now() - last)));
    shop.requests++;
    if (pathName.startsWith("/api/")) shop.apiRequests++;
    const headers = { accept: expectJson ? "application/json" : "text/plain", "user-agent": HONEST_USER_AGENT };
    if (pathName.startsWith("/api/")) headers.channel = "inet";
    if (token) headers.accesstoken = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    let text;
    try {
      // Never followed: a redirect off an API call goes somewhere we did not ask for.
      res = await fetchImpl(`${SHOP_BASE}${pathName}`, {
        method, headers, redirect: "manual", ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      text = await res.text();
    } catch (err) {
      last = now();
      return { error: err.cause?.code ?? err.message };
    }
    last = now();
    const evidence = evidenceHeaders(res.headers);
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson });
    const location = typeof res.headers?.get === "function" ? res.headers.get("location") : null;
    return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: evidence, text, block, location };
  }

  const blockedLine = (res) =>
    `BLOCKED shop.oebbtickets.at ${res.status} ${vendorLine(res.headers)} ${oneLine(res.text)}` +
    (res.block ? ` — ${describeBlock(res.block)}` : "") +
    (res.location ? ` (redirect to ${res.location}, not followed)` : "");

  // 0. robots.txt: its rules first, or no API at all.
  const robots = await shopFetch(SHOP_PATHS.robots, { expectJson: false });
  if (robots.error) return end("unreachable", `robots.txt unreachable (${robots.error}) — not asking an API whose rules could not be read`);
  if (robots.block) return end("blocked", blockedLine(robots));
  if (robots.status === 404 || robots.status === 410) {
    shop.robots = "none";
    out(`   robots.txt: HTTP ${robots.status}, no rules`);
  } else if (!robots.ok) {
    return end("skipped", `robots.txt answered HTTP ${robots.status} — treating its API as off limits (RFC 9309: unreachable rules mean disallow)`);
  } else {
    save("robots-shop.txt", robots.text);
    out(cap(robots.text, 2000).split("\n").map((l) => `   | ${l}`).join("\n"));
    if (looksLikePage(robots)) out("   (a page, not rules: RFC 9309 reads lines it cannot parse as no rules)");
    const disallowed = robotsDisallowed(robots.text, ["/api/", ...Object.values(SHOP_PATHS).filter((p) => p.startsWith("/api/"))]);
    if (disallowed.length) {
      shop.robots = "disallows";
      return end("skipped", `robots.txt disallows ${disallowed.map((d) => `${d.path} for ${d.agent} (${d.rule})`).join(", ")} — the shop step stops here`);
    }
    shop.robots = "allows";
    out("   robots.txt allows /api/ for * and for us");
  }

  // 1. The anonymous token — where a block, if there is one, will show.
  const tokenRes = await shopFetch(SHOP_PATHS.token, {});
  if (tokenRes.error) return end("unreachable", `anonymousToken unreachable (${tokenRes.error})`);
  if (tokenRes.block || !tokenRes.ok) return end("blocked", blockedLine(tokenRes));
  let token = null;
  try {
    const body = JSON.parse(tokenRes.text);
    token = body?.access_token ?? body?.accessToken ?? null;
    save("raw/shop-token.json", { status: tokenRes.status, headers: tokenRes.headers, keys: Object.keys(body ?? {}), expires_in: body?.expires_in ?? null });
    if (!token) return end("error", `anonymousToken answered without an access_token (keys: ${Object.keys(body ?? {}).join(", ")})`);
    out(`   anonymousToken: HTTP ${tokenRes.status}, token received (expires in ${body?.expires_in ?? "?"} s; not logged)`);
  } catch {
    return end("error", `anonymousToken answered HTTP ${tokenRes.status} but not JSON: ${oneLine(tokenRes.text)}`);
  }

  // 2. The session.
  const init = await shopFetch(SHOP_PATHS.init, { method: "POST", body: {}, token });
  if (init.error) return end("unreachable", `initUserData unreachable (${init.error})`);
  if (init.block || init.location || init.status === 401) return end("blocked", blockedLine(init));
  out(`   initUserData: HTTP ${init.status}${init.ok ? "" : ` ${oneLine(init.text, 120)} — some clients treat it as optional, continuing`}`);

  // 3–4. Timetable and offers per train-night: the owner's disputed nights
  // first, then nights nightjet.com priced just now, each with its own clock.
  const picks = rows
    .filter((r) => r.request.group !== "D" && (r.live?.dep || r.stored?.dep))
    .sort((a, b) => (a.request.group === "A" ? 0 : 1) - (b.request.group === "A" ? 0 : 1)
      || (a.live?.status === "priced" ? 0 : 1) - (b.live?.status === "priced" ? 0 : 1)
      || a.request.id - b.request.id)
    .slice(0, config.shop.maxTrainNights);
  if (!picks.length) out("   no sampled night has a departure time to look the train up by");
  for (const row of picks) {
    const { key, night } = row.request;
    const dep = row.live?.dep ?? row.stored.dep;
    const datetime = shopDateTime(dep, 10);
    const result = { key, night, dep, connection: null, offers: null, live: null, stored: null };
    result.live = { couchette: row.live?.le?.price ?? null, sleeperBed: row.live?.be?.price ?? null };
    result.stored = { couchette: row.stored?.couchette ?? null, sleeperBed: row.stored?.sleeperBed ?? null };
    shop.results.push(result);
    out(`   ${key} ${night} (dep ${dep}) ${row.ends.from} → ${row.ends.to}`);

    const tt = await shopFetch(SHOP_PATHS.timetable, {
      method: "POST", token,
      body: timetableBody({ datetime, fromId: row.ends.fromId, toId: row.ends.toId, from: row.ends.from, to: row.ends.to }),
    });
    if (tt.error) return end("unreachable", `timetable unreachable (${tt.error})`);
    if (tt.block || tt.location || tt.status === 401) return end("blocked", blockedLine(tt));
    save(`raw/shop-timetable-${safeName(key)}-${night}.json`, tt.text);
    out(`     timetable HTTP ${tt.status}: ${oneLine(tt.text, 600)}`);
    if (!tt.ok) {
      result.problem = `timetable HTTP ${tt.status}`;
      continue;
    }
    let ttBody;
    try {
      ttBody = JSON.parse(tt.text);
    } catch {
      result.problem = "timetable answer not JSON";
      out(`     ${result.problem}`);
      continue;
    }
    const found = findShopConnection(ttBody, { key, fromId: row.ends.fromId, toId: row.ends.toId, dep });
    if (!found.connection) {
      result.problem = found.problem;
      out(`     ${found.problem}; connections seen: ${found.candidates.map((c) => `${c.trains} ${c.from}→${c.to} ${c.departure}`).join(" | ") || "none"}`);
      continue;
    }
    result.connection = found.connection;

    const offers = await shopFetch(SHOP_PATHS.offers, {
      method: "POST", token, body: offersBody({ connectionId: found.connection.id, datetime }),
    });
    if (offers.error) return end("unreachable", `offers unreachable (${offers.error})`);
    if (offers.block || offers.location || offers.status === 401) return end("blocked", blockedLine(offers));
    save(`raw/shop-offers-${safeName(key)}-${night}.json`, offers.text);
    out(`     offers HTTP ${offers.status}: ${oneLine(offers.text, 1500)}`);
    if (!offers.ok) {
      result.problem = `offers HTTP ${offers.status}`;
      continue;
    }
    let offersParsed;
    try {
      offersParsed = JSON.parse(offers.text);
    } catch {
      result.problem = "offers answer not JSON";
      out(`     ${result.problem}`);
      continue;
    }
    result.offers = extractShopOffers(offersParsed);
    const o = result.offers;
    const byName = (slot) => Object.entries(slot.byName).map(([n, p]) => `${n} ${fmtPrice(p)}`).join(", ") || "—";
    out(`     shop couchette min ${fmtPrice(o.couchette.min)} [${byName(o.couchette)}] ladies ${fmtPrice(o.couchette.ladies)}; ` +
      `berth min ${fmtPrice(o.berth.min)} [${byName(o.berth)}]; seats seen ${o.seats} (discarded); tiers ${o.tiers.join(", ") || "—"}`);
    out(`     vs nightjet.com now: couchette ${fmtPrice(result.live.couchette)}, bed ${fmtPrice(result.live.sleeperBed)}; ` +
      `stored: couchette ${fmtPrice(result.stored.couchette)}, bed ${fmtPrice(result.stored.sleeperBed)}`);
    for (const s of o.surprises) out(`     shape surprise: ${s}`);
  }
  shop.state = "done";
  return shop;
}

// ── The report ──────────────────────────────────────────────────────────────

function buildReport({ today, config, plan, rows, summary, nj, shop }) {
  const text = [];
  const md = [];
  const both = (line) => {
    text.push(line);
    md.push(line);
  };

  const hostLine = nj.state === "ok"
    ? `nightjet.com answered ${summary.answered} of ${summary.asked} night(s) (${nj.requests} request(s))`
    : nj.state === "blocked"
      ? `nightjet.com BLOCKED after ${nj.requests} request(s): ${nj.block.reason}`
      : `nightjet.com unreachable after ${nj.requests} request(s) — no live answer to compare`;
  const shopLine = {
    disabled: "shop step off",
    ok: "shop step ran",
    done: `shop step done (${shop.apiRequests} API request(s))`,
    blocked: `shop BLOCKED after ${shop.apiRequests} API request(s)`,
    unreachable: "shop unreachable",
    skipped: "shop step skipped (robots.txt)",
    error: "shop step stopped on a surprise",
  }[shop.state] ?? shop.state;

  text.push(`═══ Summary — ${today}`);
  md.push(`## Nightjet fare check — ${today}`, "");
  both(`- ${hostLine}; robots.txt ${nj.robots ?? "not read"}`);
  both(`- ${shopLine}${shop.robots ? `; its robots.txt ${shop.robots}` : ""}`);
  both(`- exact match (status and both berth prices to the cent): spread ${summary.spreadShare}, all sampled ${summary.exactShare}`);
  const buckets = Object.entries(summary.byBucket).map(([b, v]) => `${b}d ${v.compared ? `${v.exact}/${v.compared}` : "—"}`).join(" · ");
  both(`- by lead time: ${buckets}`);
  const mad = summary.medianAbsDelta;
  both(`- median |Δ| where both priced: couchette ${fmtPrice(mad.couchette)}, bed ${fmtPrice(mad.sleeperBed)}, all ${fmtPrice(mad.all)} ` +
    `(non-zero: couchette ${summary.nonZeroDeltas.couchette}, bed ${summary.nonZeroDeltas.sleeperBed})`);
  const inv = summary.invariants;
  const broken = (v) => `${v.violations} broken of ${v.checked}`;
  both(`- invariants: live couchette > seat ${broken(inv.liveCouchetteAboveSeat)} (0 expected: a couchette is a seat ticket plus a berth); ` +
    `live bed ≥ couchette ${broken(inv.liveBedNotBelowCouchette)}; stored couchette > seat ${broken(inv.storedCouchetteAboveSeat)}`);
  const products = Object.entries(summary.products)
    .map(([cls, names]) => `${cls}: ${Object.entries(names).map(([n, c]) => `${n} ×${c}`).join(", ") || "—"}`)
    .join("; ");
  both(`- products: ${products}`);
  both(`- flags: ${Object.entries(summary.flagCounts).map(([f, n]) => `${f} ×${n}`).join(", ") || "none"}`);
  const rep = summary.repeats;
  both(`- repeats: ${rep.answered} of ${rep.asked} answered, ${rep.same} same, ${rep.differ} different`);
  const cache = Object.entries(summary.cache)
    .map(([h, v]) => `${h} ${v.present}/${v.of}${v.values ? ` (${Object.entries(v.values).slice(0, 3).map(([x, n]) => `${x} ×${n}`).join(", ")})` : ""}`)
    .join("; ");
  both(`- response headers: ${cache || "none recorded"}`);
  if (plan.dropped.length) both(`- the request cap dropped ${plan.dropped.length} night(s) (see the log)`);

  // The table: fixed width for the log, markdown for the step summary.
  text.push("", "── Nights");
  text.push(...formatTable(rows));
  text.push("   stored c/s = stored couchette/bed; live se/le/be = seat/couchette/bed with the product " +
    "(Spar = Sparschiene, SparKomf = Sparschiene Komfort, Komfort = Komfortticket, Standard = Standard-Ticket); Δ = live − stored");
  md.push("", "<details><summary>Nights</summary>", "", "```", ...formatTable(rows), "```", "", "</details>");

  const disputed = rows.filter((r) => r.disputed);
  if (disputed.length) {
    both("");
    both("### Disputed nights");
    for (const r of disputed) {
      const d = r.disputed;
      both(`- ${r.request.key} ${r.request.night}: ${d.verdict.text}` +
        (d.shop ? ` (owner: ${d.shop.product ?? "?"}, ${d.shop.compartment ?? "?"}, seen ${d.shop.seenAt ?? "?"})` : "") +
        (d.note ? ` — ${d.note}` : ""));
    }
  }

  const pairLines = [];
  for (const [a, b] of config.coupledPairs) {
    const nights = [...new Set(rows.filter((r) => r.request.key === a && r.request.reasons.includes(`coupled with ${b}`)).map((r) => r.request.night))];
    for (const night of nights) {
      const ra = rows.find((r) => r.request.key === a && r.request.night === night && r.request.group !== "D");
      const rb = rows.find((r) => r.request.key === b && r.request.night === night && r.request.group !== "D");
      const show = (r) => (r?.live
        ? `${r.live.status}${r.live.reason ? `:${r.live.reason}` : ""} dep ${r.live.dep?.slice(11) ?? "—"} le ${fmtPrice(r.live.le?.price ?? null)} be ${fmtPrice(r.live.be?.price ?? null)} se ${fmtPrice(r.live.se?.price ?? null)}`
        : r?.error ?? r?.skipped ?? "not asked");
      pairLines.push(`- ${night} ${a}: ${show(ra)} | ${b}: ${show(rb)}`);
    }
  }
  if (pairLines.length) {
    both("");
    both("### Coupled trains, same night");
    for (const l of pairLines) both(l);
  }

  if (shop.results.length) {
    both("");
    both("### ÖBB shop");
    for (const r of shop.results) {
      const o = r.offers;
      both(`- ${r.key} ${r.night}: ${o
        ? `shop couchette ${fmtPrice(o.couchette.min)} (ladies ${fmtPrice(o.couchette.ladies)}), berth ${fmtPrice(o.berth.min)}`
        : r.problem ?? "no offers"}; nightjet.com now couchette ${fmtPrice(r.live.couchette)}, bed ${fmtPrice(r.live.sleeperBed)}; ` +
        `stored couchette ${fmtPrice(r.stored.couchette)}, bed ${fmtPrice(r.stored.sleeperBed)}`);
    }
  }

  md.push("", `Columns: ${TABLE_COLUMNS.map(([h]) => h).join(" · ")}. The CSV checklist and raw answers are in the run's artifact.`, "");
  return { text, markdown: `${md.join("\n")}\n` };
}

async function main() {
  const outDir = process.argv[2] ?? null;
  try {
    await runProbe({ outDir });
  } catch (err) {
    console.error(`probe-nj-fares: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
