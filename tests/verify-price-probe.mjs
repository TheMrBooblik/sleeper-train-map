// tests/verify-price-probe.mjs
// Pure unit tests for the weekly price probe's target selection, health record
// and price extraction. No network. Run: npm run verify-price-probe
//
// These cover the two bugs that kept data/canonical/prices.json at one entry
// while the probe ran every Monday for months: the sample was pinned to the
// first four of seventy routes, and a probe that found nothing looked exactly
// like a probe with nothing to report.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectProbeTargets, weeksSinceEpoch } from "../scripts/lib/probe-rotation.mjs";
import { mergeProbeHealth, normalizeProbeResult } from "../scripts/lib/probe-health.mjs";
import { collectPriceCandidates, extractMinPrice } from "../scripts/lib/price-extract.mjs";
import { loadRegistry, validateRegistryEntry } from "../scripts/lib/registry.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const routes = (n) => [...Array(n)].map((_, i) => ({ routeKey: `r${String(i).padStart(2, "0")}` }));
const pricedAt = (keys, sampledAt = "2026-01-01T00:00:00Z") =>
  Object.fromEntries(keys.map((k) => [k, { fromPrice: 42, sampledAt }]));

// ─── selectProbeTargets: coverage over time ─────────────────────────────────

check("advances a whole page per run, so successive runs cover new ground", () => {
  const all = routes(10);
  const week = (r) => selectProbeTargets(all, {}, { sampleSize: 4, rotation: r }).map((c) => c.routeKey);
  assert.deepStrictEqual(week(0), ["r00", "r01", "r02", "r03"]);
  assert.deepStrictEqual(week(1), ["r04", "r05", "r06", "r07"]);
  // Wraps around rather than running out.
  assert.deepStrictEqual(week(2), ["r08", "r09", "r00", "r01"]);
});

check("reaches every route — the old slice(0,4) never left the first page", () => {
  const all = routes(70); // the live NightJet candidate count
  const seen = new Set();
  for (let r = 0; r < 18; r++) {
    for (const c of selectProbeTargets(all, {}, { sampleSize: 4, rotation: r })) seen.add(c.routeKey);
  }
  assert.strictEqual(seen.size, 70, `covered ${seen.size}/70 routes in 18 runs`);
});

check("spends the budget on routes with no price before re-checking priced ones", () => {
  const all = routes(10);
  const prices = pricedAt(["r00", "r01", "r02", "r03", "r04", "r05"]);
  const picked = selectProbeTargets(all, prices, { sampleSize: 4, rotation: 0 });
  assert.deepStrictEqual(
    picked.map((c) => c.routeKey),
    ["r06", "r07", "r08", "r09"],
    "all four slots should go to unpriced routes",
  );
});

check("once everything is priced, re-checks the stalest first", () => {
  const all = routes(4);
  const prices = {
    r00: { fromPrice: 1, sampledAt: "2026-05-01T00:00:00Z" },
    r01: { fromPrice: 1, sampledAt: "2026-01-01T00:00:00Z" }, // stalest
    r02: { fromPrice: 1, sampledAt: "2026-03-01T00:00:00Z" },
    r03: { fromPrice: 1 }, // unknown → treated as oldest, not as fresh
  };
  const picked = selectProbeTargets(all, prices, { sampleSize: 2, rotation: 7 });
  assert.deepStrictEqual(picked.map((c) => c.routeKey), ["r03", "r01"]);
});

check("a partly-covered run fills the remaining budget with priced routes", () => {
  const all = routes(3);
  const picked = selectProbeTargets(all, pricedAt(["r00", "r01"]), { sampleSize: 3, rotation: 0 });
  assert.deepStrictEqual(picked.map((c) => c.routeKey).slice(0, 1), ["r02"], "unpriced goes first");
  assert.strictEqual(picked.length, 3, "budget is filled, not left short");
  assert.strictEqual(new Set(picked.map((c) => c.routeKey)).size, 3, "no route probed twice in a run");
});

check("selection does not depend on the order the scrape happened to write", () => {
  const forward = routes(9);
  const shuffled = [...forward].reverse();
  const keys = (list) =>
    selectProbeTargets(list, {}, { sampleSize: 3, rotation: 4 }).map((c) => c.routeKey);
  assert.deepStrictEqual(keys(forward), keys(shuffled));
});

check("total on empty and malformed input", () => {
  assert.deepStrictEqual(selectProbeTargets([], {}, { sampleSize: 4 }), []);
  assert.deepStrictEqual(selectProbeTargets(null, null, {}), []);
  assert.deepStrictEqual(selectProbeTargets(routes(3), {}, { sampleSize: 0 }), []);
  assert.deepStrictEqual(
    selectProbeTargets([{ routeKey: "" }, null, { nope: 1 }], {}, { sampleSize: 2 }),
    [],
    "entries without a routeKey are dropped, not probed as undefined",
  );
});

check("weeksSinceEpoch is monotone across a year boundary", () => {
  const dec = weeksSinceEpoch(Date.parse("2026-12-28T00:00:00Z"));
  const jan = weeksSinceEpoch(Date.parse("2027-01-11T00:00:00Z"));
  assert.ok(jan > dec, `${jan} should exceed ${dec} — an ISO week number would have reset`);
});

// ─── probe health: a dead probe has to be legible ───────────────────────────

check("normalizeProbeResult accepts both the array and the reporting shape", () => {
  assert.deepStrictEqual(normalizeProbeResult([{ routeKey: "a" }]), {
    prices: [{ routeKey: "a" }],
    attempted: 1,
    errors: [],
  });
  assert.deepStrictEqual(
    normalizeProbeResult({ prices: [], attempted: 4, errors: ["HTTP 404", ""] }),
    { prices: [], attempted: 4, errors: ["HTTP 404"] },
  );
  assert.deepStrictEqual(normalizeProbeResult(undefined), { prices: [], attempted: 0, errors: [] });
});

check("consecutive empty runs accumulate and reset on a find", () => {
  const entries = [{ id: "nightjet", probe: { pricing: { adapter: "nightjet-offers" } } }];
  const empty = { nightjet: { prices: [], attempted: 4, errors: ["HTTP 403"] } };
  let health = mergeProbeHealth({}, entries, empty, "2026-01-05T00:00:00Z");
  assert.strictEqual(health.nightjet.consecutiveEmptyRuns, 1);
  assert.strictEqual(health.nightjet.lastError, "HTTP 403");
  assert.strictEqual(health.nightjet.lastSuccessAt, null);

  health = mergeProbeHealth(health, entries, empty, "2026-01-12T00:00:00Z");
  assert.strictEqual(health.nightjet.consecutiveEmptyRuns, 2, "the number that makes it visible");

  health = mergeProbeHealth(
    health,
    entries,
    { nightjet: { prices: [{ routeKey: "a" }], attempted: 4, errors: [] } },
    "2026-01-19T00:00:00Z",
  );
  assert.strictEqual(health.nightjet.consecutiveEmptyRuns, 0);
  assert.strictEqual(health.nightjet.lastSuccessAt, "2026-01-19T00:00:00Z");
  assert.strictEqual(health.nightjet.lastFailureAt, "2026-01-12T00:00:00Z", "kept, not erased");
});

check("errors alongside a price are a partial run, not a failure", () => {
  const entries = [{ id: "nightjet", probe: { pricing: { adapter: "nightjet-offers" } } }];
  const health = mergeProbeHealth(
    {},
    entries,
    { nightjet: { prices: [{ routeKey: "a" }], attempted: 4, errors: ["HTTP 500"] } },
    "2026-02-02T00:00:00Z",
  );
  assert.strictEqual(health.nightjet.lastFailureAt, null);
  assert.strictEqual(health.nightjet.lastSuccessAt, "2026-02-02T00:00:00Z");
});

check("a probe that did not run this time carries its record forward untouched", () => {
  const prior = {
    nightjet: { lastRunAt: "2026-01-05T00:00:00Z", found: 3, consecutiveEmptyRuns: 0 },
  };
  const health = mergeProbeHealth(
    prior,
    [{ id: "nightjet", probe: { pricing: { adapter: "nightjet-offers" } } }],
    {},
    "2026-01-12T00:00:00Z",
  );
  assert.strictEqual(health.nightjet.lastRunAt, "2026-01-05T00:00:00Z");
  assert.strictEqual(health.nightjet.found, 3);
});

// ─── price extraction ───────────────────────────────────────────────────────

check("the debug walk reports exactly what the extractor picks", () => {
  const body = { offers: [{ totalPrice: 59.9 }, { price: "49,90 €" }], tripId: 1234 };
  const found = collectPriceCandidates(body);
  assert.deepStrictEqual(found.map((f) => f.path), ["offers[0].totalPrice", "offers[1].price"]);
  assert.strictEqual(extractMinPrice(body), 49.9);
  assert.strictEqual(
    Math.min(...found.map((f) => f.value)),
    extractMinPrice(body),
    "a second hand-written walk would drift; these must agree",
  );
});

check("keys that only look like prices stay out", () => {
  assert.strictEqual(extractMinPrice({ priceId: 42, durationPrice: 99, fareCode: 500 }), null);
  assert.strictEqual(extractMinPrice({ price: 2 }), null, "below the plausible floor");
  assert.strictEqual(extractMinPrice({ price: 99999 }), null, "above the plausible ceiling");
  assert.strictEqual(extractMinPrice(null), null);
});

// ─── registry wiring ────────────────────────────────────────────────────────

check("probe.pricing is validated, so a typo cannot silently disable the probe", () => {
  const base = { id: "x", label: "X", kind: "json-api", adapter: "a", enabled: true };
  const errs = (probe) =>
    validateRegistryEntry({ ...base, probe }).filter((e) => e.includes("probe.pricing"));
  assert.deepStrictEqual(errs(undefined), []);
  assert.deepStrictEqual(errs({ pricing: { adapter: "nightjet-offers" } }), []);
  assert.strictEqual(errs({ pricing: { adapter: "" } }).length, 1);
  assert.strictEqual(errs({ pricing: {} }).length, 1, "a missing adapter is an error");
  assert.strictEqual(errs({ pricing: { adapter: "a", sampleRoutes: 0 } }).length, 1);
  assert.strictEqual(errs({ pricing: { adapter: "a", sampleRoutes: 2.5 } }).length, 1);
});

check("every configured probe adapter exists and exports what the runner calls", async () => {
  const configured = loadRegistry().filter((e) => e.probe?.pricing?.adapter);
  assert.ok(configured.length > 0, "the registry should still configure at least one price probe");
  for (const entry of configured) {
    const file = path.join(ROOT, "scripts", "adapters", `${entry.probe.pricing.adapter}.mjs`);
    assert.ok(fs.existsSync(file), `${entry.id}: adapter file missing — ${file}`);
    const mod = await import(file);
    assert.strictEqual(typeof mod.probePrices, "function", `${entry.id}: no probePrices() export`);
    // The debug script inspects a probe through these; without them it would
    // have to rebuild the adapter's request and could print a URL the nightly
    // job never calls.
    assert.strictEqual(typeof mod.probeCandidates, "function", `${entry.id}: no probeCandidates()`);
    assert.strictEqual(typeof mod.buildProbeUrl, "function", `${entry.id}: no buildProbeUrl()`);
  }
});

console.log(`\n[verify-price-probe] ${passed} checks passed`);
