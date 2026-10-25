// scripts/probe-prices-debug.mjs
// What the weekly price probe actually sees, printed.
//
// The probe's failure mode is invisible by construction — it reaches an
// undocumented booking API, extracts nothing, files no proposal, and its
// workflow step is continue-on-error. This is the counterpart to
// "Probe CFR source" / "Probe 12306 source": it calls the same URL the nightly
// job calls, then prints the HTTP status, the response's shape, and every field
// the extractor considered a price. Run it from Actions, where egress to the
// operator is open (a dev sandbox usually has none).
//
//   node scripts/probe-prices-debug.mjs                    # first candidate of each probe
//   node scripts/probe-prices-debug.mjs --source nightjet --limit 3
//   node scripts/probe-prices-debug.mjs --route nj_standalone_NJ_421

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./lib/registry.mjs";
import { collectPriceCandidates, extractMinPrice } from "./lib/price-extract.mjs";
import { fetchWithTimeout } from "./lib/scrape-helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJsonLocal(...segments) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), "utf8"));
  } catch {
    return null;
  }
}

/** A one-line sketch of a value's shape, so a 200 that is not JSON is obvious. */
function shapeOf(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} × ${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (depth >= 1) return `{${keys.length} keys}`;
    return `{ ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""} }`;
  }
  return typeof value;
}

/** A descriptive agent, as the repo's other probes use — identification, not disguise. */
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://pingwi.com)";

/**
 * When the endpoint answers but rejects us, ask what it would accept.
 *
 * An undocumented booking backend returning 400 tells you the service is alive
 * and your request is wrong, but not how. These are the cheap hypotheses — a
 * real agent and language (many booking backends refuse a bare fetch), the
 * usual query parameters, and the path without its last segment, which
 * separates "this route does not exist" (404) from "it does, your arguments are
 * wrong" (400). One run, several answers.
 *
 * If none of them work, the fastest remaining route is a human with devtools
 * open on the operator's own booking page, copying the request it really makes.
 */
async function probeVariants(url) {
  const withQuery = (q) => `${url}${url.includes("?") ? "&" : "?"}${q}`;
  const variants = [
    ["browser-ish headers", url, { accept: "application/json", "user-agent": USER_AGENT, "accept-language": "en-GB,en;q=0.9" }],
    ["+ lang/currency", withQuery("lang=en&currency=EUR"), { accept: "application/json", "user-agent": USER_AGENT }],
    ["+ one adult", withQuery("adults=1&children=0"), { accept: "application/json", "user-agent": USER_AGENT }],
    ["path without the date", url.slice(0, url.lastIndexOf("/")), { accept: "application/json", "user-agent": USER_AGENT }],
  ];

  console.log("   — the host answered, so the request shape is what it rejects. Variants:");
  for (const [label, target, headers] of variants) {
    try {
      const r = await fetchWithTimeout(target, { headers });
      const text = (await r.text()).slice(0, 160).replace(/\s+/g, " ");
      console.log(`     ${label.padEnd(22)} → ${r.status} ${text}`);
    } catch (err) {
      console.log(`     ${label.padEnd(22)} → failed: ${err.message}`);
    }
  }
}

async function main() {
  const registry = loadRegistry();
  const wanted = arg("source");
  const routeFilter = arg("route");
  const limit = Number(arg("limit", routeFilter ? "1" : "1")) || 1;

  const entries = registry.filter(
    (e) => e.probe?.pricing?.adapter && (!wanted || e.id === wanted),
  );
  if (entries.length === 0) {
    console.log(
      wanted
        ? `[debug] no probe.pricing config on source "${wanted}"`
        : "[debug] no probe.pricing configs in the registry",
    );
    return;
  }

  const seen = readJsonLocal("data", "canonical", "state", "seen.json");
  const prices = readJsonLocal("data", "canonical", "prices.json") ?? {};
  const ctx = {
    rootDir: ROOT,
    seenRoutes: new Set(Object.keys(seen?.routes ?? {})),
    prices,
  };

  for (const entry of entries) {
    console.log(`\n═══ ${entry.id} (${entry.probe.pricing.adapter}) ═══`);
    const mod = await import(`./adapters/${entry.probe.pricing.adapter}.mjs`);
    if (typeof mod.probeCandidates !== "function" || typeof mod.buildProbeUrl !== "function") {
      console.log(
        "[debug] adapter exports no probeCandidates()/buildProbeUrl() — nothing to inspect " +
          "without repeating its request logic here, which would drift from what it sends.",
      );
      continue;
    }

    let candidates;
    try {
      candidates = mod.probeCandidates(entry, ctx);
    } catch (err) {
      console.log(`[debug] candidates unavailable: ${err.message}`);
      continue;
    }
    const priced = candidates.filter((c) => Number.isFinite(prices[c.routeKey]?.fromPrice)).length;
    console.log(
      `${candidates.length} probe-able route(s); ${priced} already priced, ${candidates.length - priced} without a price`,
    );

    const targets = (routeFilter
      ? candidates.filter((c) => c.routeKey === routeFilter)
      : candidates
    ).slice(0, limit);
    if (targets.length === 0) {
      console.log(`[debug] no candidate matches --route ${routeFilter}`);
      continue;
    }

    const date = typeof mod.sampleDate === "function" ? mod.sampleDate() : null;
    for (const c of targets) {
      const url = mod.buildProbeUrl({ ...c, date });
      console.log(`\n── ${c.lineName ?? c.routeKey} (${c.routeKey})`);
      console.log(`   GET ${url}`);
      let res;
      try {
        res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
      } catch (err) {
        // Which LAYER broke, not just that something did. node's fetch hangs the
        // real cause off err.cause, and the distinction decides the next move:
        // ENOTFOUND is DNS/blocklist, UND_ERR_CONNECT_TIMEOUT is the host
        // refusing or unreachable from a runner (data.gov.ro does exactly this
        // to the CFR probe), CERT_* is TLS, ABORT is our own timeout.
        const cause = err.cause ?? {};
        const code = cause.code ?? err.code ?? err.name ?? "unknown";
        console.log(`   ✗ request failed [${code}]: ${err.message}`);
        if (cause.message && cause.message !== err.message) {
          console.log(`     cause: ${cause.message}`);
        }
        continue;
      }
      console.log(`   ← HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`);
      const body = await res.text();
      if (!res.ok) {
        console.log(`   body: ${body.slice(0, 400)}`);
        // A 4xx means the host is up and answering — the request SHAPE is what
        // it rejects, which is a different problem from an unreachable API and
        // needs different information to fix. Try the obvious variations in the
        // same run rather than costing a whole dispatch per hypothesis.
        if (res.status >= 400 && res.status < 500) await probeVariants(url);
        continue;
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        // A 200 of HTML is the classic "API moved, now serving the SPA shell".
        console.log(`   ✗ not JSON (${body.length} bytes): ${body.slice(0, 200)}`);
        continue;
      }
      console.log(`   shape: ${shapeOf(data)}`);

      const found = collectPriceCandidates(data);
      if (found.length === 0) {
        console.log(
          "   ✗ no price-like field. The extractor wants a key matching /price|amount|fare/ " +
            "whose value is 5..2000; check the shape above for what the fare is called now.",
        );
        continue;
      }
      console.log(`   ✓ ${found.length} price-like field(s), cheapest ${extractMinPrice(data)}:`);
      for (const f of found.slice(0, 12)) {
        console.log(`     ${f.value}  ←  ${f.path}${f.raw === f.value ? "" : `  (${f.raw})`}`);
      }
      if (found.length > 12) console.log(`     … ${found.length - 12} more`);
    }
  }
}

main().catch((err) => {
  console.error("[debug] fatal:", err);
  process.exit(1);
});
