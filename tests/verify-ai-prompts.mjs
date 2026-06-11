// tests/verify-ai-prompts.mjs
// Unit tests for the AI batch helpers: prompt builders, response parsers,
// fuzzy alias candidates, JSON extraction, defensive price extraction.
// No network — the AI client itself is exercised only in Actions.
// Run: npm run verify-ai
import assert from "node:assert";
import {
  levenshtein,
  findAliasCandidates,
  buildStationMatchPrompt,
  parseStationMatch,
  buildPricingPrompt,
  parsePricing,
  buildSummaryPrompt,
  parseSummary,
} from "../scripts/ai-tasks.mjs";
import { extractJson } from "../scripts/lib/ai.mjs";
import { extractMinPrice } from "../scripts/lib/price-extract.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── levenshtein / candidates ────────────────────────────────────────────────
check("levenshtein basics", () => {
  assert.strictEqual(levenshtein("wien", "wien"), 0);
  assert.strictEqual(levenshtein("rome termini", "roma termini"), 1);
  assert.strictEqual(levenshtein("abc", "xyz"), 3);
  assert.ok(levenshtein("short", "a much longer string entirely") > 3);
});

check("findAliasCandidates flags near-misses, skips exact matches", () => {
  const injected = ["Rome Termini", "Wien Hbf", "Bruxelles-Midi"];
  const bot = ["Roma Termini", "Wien Hbf", "Bruxelles Midi / Brussel Zuid", "Paris Est"];
  const out = findAliasCandidates(injected, bot);
  const byInjected = Object.fromEntries(out.map((c) => [c.injected, c.candidate]));
  assert.strictEqual(byInjected["Rome Termini"], "Roma Termini");
  assert.ok(!("Wien Hbf" in byInjected), "exact match must be skipped");
});

check("findAliasCandidates respects cap", () => {
  const injected = Array.from({ length: 20 }, (_, i) => `Stop ${i}x`);
  const bot = Array.from({ length: 20 }, (_, i) => `Stop ${i}y`);
  assert.ok(findAliasCandidates(injected, bot, 3).length <= 3);
});

// ── prompts & parsers ───────────────────────────────────────────────────────
check("station match prompt includes both names; parser validates", () => {
  const p = buildStationMatchPrompt({ injected: "Mailand Centrale", candidate: "Milano Centrale" });
  assert.ok(p.user.includes("Mailand Centrale") && p.user.includes("Milano Centrale"));
  assert.deepStrictEqual(parseStationMatch({ same: true, confidence: 0.95 }), {
    same: true,
    confidence: 0.95,
  });
  assert.strictEqual(parseStationMatch({ same: "yes", confidence: 1 }), null);
  assert.strictEqual(parseStationMatch({ same: true, confidence: 7 }), null);
  assert.strictEqual(parseStationMatch(null), null);
});

check("pricing prompt truncates page text; parser validates", () => {
  const p = buildPricingPrompt({ text: "x".repeat(10000), routeKey: "icn_770", notes: "look for €" });
  assert.ok(p.user.length < 7000);
  assert.deepStrictEqual(parsePricing({ fromPrice: 49.9, currency: "eur" }), {
    fromPrice: 49.9,
    currency: "EUR",
  });
  assert.strictEqual(parsePricing({ fromPrice: null, currency: "EUR" }), null);
  assert.strictEqual(parsePricing({ fromPrice: -3, currency: "EUR" }), null);
  assert.strictEqual(parsePricing({ fromPrice: 20, currency: "EURO" }), null);
});

check("summary prompt carries the envelope; parser bounds lengths", () => {
  const p = buildSummaryPrompt({
    kind: "route.add",
    title: "t",
    summary: "s",
    target: { routeKey: "x" },
    before: null,
    after: { origin: "A" },
  });
  assert.ok(p.user.includes("route.add"));
  assert.deepStrictEqual(parseSummary({ title: "New train A–B", summary: "ok" }), {
    title: "New train A–B",
    summary: "ok",
  });
  assert.strictEqual(parseSummary({ title: "x".repeat(200), summary: "" }), null);
  assert.strictEqual(parseSummary({}), null);
});

// ── JSON extraction from model output ──────────────────────────────────────
check("extractJson handles fences, prose, and junk", () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('Sure! Here you go: {"same": true, "confidence": 0.9} hope it helps'), {
    same: true,
    confidence: 0.9,
  });
  assert.strictEqual(extractJson("no json here"), null);
  assert.strictEqual(extractJson(null), null);
});

// ── defensive price extraction ──────────────────────────────────────────────
check("extractMinPrice finds the cheapest plausible fare", () => {
  const response = {
    connections: [
      { id: 991234, duration: 720, offers: [{ price: { amount: 79.9, currency: "EUR" } }] },
      { id: 991235, bestPrice: "49,90 €", distanceKm: 1200 },
    ],
    requestId: 555,
  };
  assert.strictEqual(extractMinPrice(response), 49.9);
});
check("extractMinPrice ignores ids, dates, counts and out-of-range values", () => {
  assert.strictEqual(
    extractMinPrice({ priceId: 12345, totalAmount: 2, items: [{ fare: 30000 }] }),
    null,
  );
  assert.strictEqual(extractMinPrice({}), null);
  assert.strictEqual(extractMinPrice(null), null);
});

console.log(`\n[verify-ai] ${passed} checks passed`);
