// tests/verify-seo-faq.mjs
// Unit tests for the pure FAQ builders used by /trains/[slug] and
// /connections/[pair]. Run: npm run verify-seo-faq
//
// The builders must be data-only (no invented facts): a question appears only
// when its supporting field is present, and no answer is ever empty — otherwise
// we'd emit malformed FAQPage structured data.

import { buildRouteFaq, buildConnectionFaq } from "../src/lib/seo/routeFaq.mjs";

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// Every FAQ item must be a {q,a} of non-empty trimmed strings, with unique qs.
function assertShape(faq, label) {
  check(Array.isArray(faq), `${label}: returns an array`);
  const seen = new Set();
  for (const item of faq) {
    check(
      item && typeof item.q === "string" && item.q.trim().length > 0,
      `${label}: non-empty question`,
    );
    check(
      item && typeof item.a === "string" && item.a.trim().length > 0,
      `${label}: non-empty answer (q=${item?.q})`,
    );
    check(!seen.has(item.q), `${label}: duplicate question "${item?.q}"`);
    seen.add(item.q);
  }
}

// ── buildRouteFaq ───────────────────────────────────────────────────────────

// Missing endpoints → no FAQ (can't phrase a question).
check(buildRouteFaq({}).length === 0, "route: empty input → []");
check(
  buildRouteFaq({ origin: "Amsterdam" }).length === 0,
  "route: missing destination → []",
);

// Full data → all six questions, well-formed.
{
  const faq = buildRouteFaq({
    origin: "Amsterdam",
    destination: "Zürich",
    operators: ["ÖBB Nightjet"],
    durationText: "11h 20m",
    departureTime: "20:01",
    arrivalTime: "08:19",
    fromPrice: "from €39",
    classes: "Seats, couchettes and sleepers",
    trainNumbers: ["NJ 40295"],
  });
  assertShape(faq, "route/full");
  check(faq.length === 6, `route/full: 6 questions (got ${faq.length})`);
  const joined = faq.map((f) => `${f.q} ${f.a}`).join("\n");
  check(joined.includes("11h 20m"), "route/full: duration in answer");
  check(
    joined.includes("departs Amsterdam at 20:01") &&
      joined.includes("arrives in Zürich at 08:19"),
    "route/full: departure + arrival times",
  );
  // fromPrice already carries "from €39" — must not double the word "from".
  check(
    joined.includes("tickets start from €39.") &&
      !joined.includes("start from from"),
    "route/full: price phrasing has no doubled 'from'",
  );
  check(joined.includes("NJ 40295"), "route/full: train number in operator answer");
}

// Sparse data → only the supported questions, none empty.
{
  const faq = buildRouteFaq({
    origin: "Baku",
    destination: "Tbilisi",
    operators: [],
    durationText: "",
    departureTime: "",
    arrivalTime: "",
    fromPrice: "",
    classes: "",
    trainNumbers: [],
  });
  assertShape(faq, "route/sparse");
  check(faq.length === 0, `route/sparse: no questions when no data (got ${faq.length})`);
}

// Numeric-only class codes must NOT produce a classes question.
{
  const faq = buildRouteFaq({
    origin: "A",
    destination: "B",
    classes: "1, 2, 3",
  });
  check(
    !faq.some((f) => /classes are available/.test(f.q)),
    "route: numeric class codes are skipped",
  );
}

// Departure without arrival → single-clause sentence, still valid.
{
  const faq = buildRouteFaq({
    origin: "A",
    destination: "B",
    departureTime: "21:15",
  });
  assertShape(faq, "route/dep-only");
  const dep = faq.find((f) => /leave\?/.test(f.q));
  check(dep && dep.a === "It departs A at 21:15.", "route/dep-only: clean single-clause");
}

// ── buildConnectionFaq ──────────────────────────────────────────────────────

check(buildConnectionFaq({}).length === 0, "connection: empty input → []");

{
  const faq = buildConnectionFaq({
    originCity: "Amsterdam",
    destCity: "Vienna",
    trainCount: 3,
    operators: ["ÖBB Nightjet", "European Sleeper"],
    fastestDurationText: "14h 05m",
    fromPrice: "from €29",
  });
  assertShape(faq, "connection/full");
  check(faq.length === 4, `connection/full: 4 questions (got ${faq.length})`);
  const joined = faq.map((f) => `${f.q} ${f.a}`).join("\n");
  check(joined.includes("3 night trains connect"), "connection/full: count + plural");
  check(
    joined.includes("ÖBB Nightjet and European Sleeper"),
    "connection/full: operators human-joined",
  );
  check(joined.includes("14h 05m"), "connection/full: fastest duration");
  check(joined.includes("from €29"), "connection/full: from price");
}

// Count-only connection (no operators/price/duration) still yields one clean Q.
{
  const faq = buildConnectionFaq({
    originCity: "X",
    destCity: "Y",
    trainCount: 2,
  });
  assertShape(faq, "connection/count-only");
  check(faq.length === 1, `connection/count-only: exactly 1 (got ${faq.length})`);
  check(faq[0].a === "2 night trains connect X and Y.", "connection/count-only: clean answer");
}

// ── Report ──────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error(`✗ verify-seo-faq: ${problems.length} problem(s)`);
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}
console.log("✓ verify-seo-faq: all checks passed");
