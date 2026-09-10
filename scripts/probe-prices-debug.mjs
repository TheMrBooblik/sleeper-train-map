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
