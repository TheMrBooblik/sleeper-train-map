// tests/verify-seo-faq.mjs
// Unit tests for the pure FAQ builders used by /trains/[slug] and
// /connections/[pair]. Run: npm run verify-seo-faq
//
// The builders must be data-only (no invented facts): a question appears only
// when its supporting field is present, and no answer is ever empty — otherwise
// we'd emit malformed FAQPage structured data.

import { buildRouteFaq, buildConnectionFaq, costAnswer } from "../src/lib/seo/routeFaq.mjs";
import OPERATOR_PRICING from "../data/overrides/operator-pricing.json" with { type: "json" };
import OPERATOR_BOOKING from "../data/overrides/operator-booking.json" with { type: "json" };
import { pricingAdvice, formatCheckedAt } from "../src/lib/pricingAdvice.mjs";

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

// ── costAnswer: the cost question, with or without a figure ────────────────
// Until the probes fill in a price, every page omitted the cost question
// entirely and so said nothing at all about the most commercial question a
// searcher asks. The pricing MODEL answers it honestly — and the two models say
// opposite things, so getting them the wrong way round is worse than silence.
{
  const priced = costAnswer({ fromPrice: "from €39", pricingType: "dynamic" });
  check(priced.includes("from €39"), "cost: a real figure is used when there is one");
  // Intent, not prose: a figure on a yield-managed operator must still point the
  // reader at booking early. Pinning the exact sentence made this test fail when
  // the wording was corrected, which is the test's fault, not the wording's.
  check(
    /book early|go first|limited/i.test(priced),
    `cost: a figure on a dynamic operator must still point at booking early — got "${priced}"`,
  );

  const dyn = costAnswer({ pricingType: "dynamic", operatorNames: "ÖBB" });
  check(dyn.startsWith("ÖBB "), "cost: names the operator when known");
  check(
    /book|early|first/i.test(dyn) && !/does not make it cheaper/.test(dyn),
    "cost/dynamic: must tell the reader booking early helps",
  );

  const fixed = costAnswer({ pricingType: "fixed", operatorNames: "ČD" });
  check(
    /does not make it cheaper/.test(fixed),
    "cost/fixed: must NOT tell the reader booking early is cheaper — it is not",
  );
  check(
    dyn !== fixed && !/yield/i.test(fixed),
    "cost: the two models give genuinely different answers",
  );

  check(costAnswer({}) === "", "cost: an operator with no record answers nothing, not a guess");
  check(costAnswer() === "", "cost: total on no input");
  check(
    costAnswer({ pricingType: "surge" }) === "",
    "cost: an unknown pricing type answers nothing rather than falling through",
  );
  check(
    costAnswer({ pricingType: "dynamic" }).startsWith("sells") === false,
    "cost: no operator name must not leave a dangling sentence start",
  );

  // The question now appears without any price, which is the point.
  const faq = buildConnectionFaq({
    originCity: "Vienna",
    destCity: "Rome",
    trainCount: 2,
    operators: ["ÖBB"],
    pricingType: "dynamic",
  });
  assertShape(faq, "connection/priceless-cost");
  check(
    faq.some((f) => f.q.startsWith("How much")),
    "connection: the cost question appears from the model alone",
  );
  check(
    !buildConnectionFaq({
      originCity: "Vienna",
      destCity: "Rome",
      trainCount: 2,
      operators: ["ÖBB"],
    }).some((f) => f.q.startsWith("How much")),
    "connection: no model and no price still means no cost question",
  );

  // Every committed record must produce an answer — a record whose type the
  // builder does not recognise would silently go back to saying nothing.
  for (const [agencyId, pricing] of Object.entries(OPERATOR_PRICING)) {
    check(
      costAnswer({ pricingType: pricing.type, operatorNames: agencyId }) !== "",
      `operator-pricing ${agencyId}: type "${pricing.type}" produces no cost answer`,
    );
  }
}

// ── pricingAdvice: one source for "buy now or later" ───────────────────────
// This wording reaches the facts tile above the Book button, the map panel's
// trip badge, the CTA caption and both FAQ builders. The point of centralising
// it is that a page can never advise "book early" in one place and "no rush"
// in another, so the tests are about the CONTRACT, not the prose.
{
  const dyn = pricingAdvice({ type: "dynamic" });
  const fix = pricingAdvice({ type: "fixed" });

  check(dyn.action === "book-early", "advice/dynamic: action is book-early");
  check(fix.action === "price-is-fixed", "advice/fixed: action is price-is-fixed");

  for (const [label, a] of [["dynamic", dyn], ["fixed", fix]]) {
    for (const field of ["action", "headline", "guidance", "short", "detail"]) {
      check(
        typeof a[field] === "string" && a[field].trim().length > 0,
        `advice/${label}: ${field} must be a non-empty string`,
      );
    }
    // Both land in a badge or next to a button; a long one wraps or truncates.
    check(a.headline.length <= 16, `advice/${label}: headline too long for a badge — "${a.headline}"`);
    // headline sits in a badge, guidance opens a sentence — different budgets.
    check(a.guidance.length <= 32, `advice/${label}: guidance too long — "${a.guidance}"`);
    // headline names the fare, guidance says what to do about it. Collapsing
    // them is what put "Book early" on a badge, an instruction with its
    // reasoning missing and no obvious connection to the price beside it.
    check(
      /fare|pricing|tariff/i.test(a.headline),
      `advice/${label}: headline must NAME the fare model, got "${a.headline}"`,
    );
    check(
      /book|buy/i.test(a.guidance) && !/fare|tariff/i.test(a.guidance),
      `advice/${label}: guidance must be an instruction, got "${a.guidance}"`,
    );
    // detail is a sentence BODY: callers prepend a subject and append the stop.
    check(
      !/^[A-Z]/.test(a.detail) && !a.detail.endsWith("."),
      `advice/${label}: detail must be a mid-sentence clause, got "${a.detail}"`,
    );
  }

  // The two must not merely differ — they must give opposite instructions.
  // Tested by MEANING: dynamic must make waiting cost you something (the cheap
  // fares run out), fixed must promise the price itself will not move. Matching
  // literal phrases here is what broke when the dynamic wording was corrected
  // away from the false "prices only rise".
  check(
    /first|limited|early|sell out/i.test(dyn.short),
    `advice/dynamic: must say waiting costs you the cheap fares — got "${dyn.short}"`,
  );
  check(
    /won't rise|not rise|fixed/i.test(fix.short),
    `advice/fixed: must say the price itself does not move — got "${fix.short}"`,
  );
  check(
    dyn.action !== fix.action && dyn.short !== fix.short,
    "advice: the two models must not collapse to the same instruction",
  );
  check(
    /sell out/i.test(fix.short) || /sell out/i.test(fix.detail),
    "advice/fixed: must warn berths sell out — a fixed price is not 'book whenever'",
  );

  check(pricingAdvice(null) === null, "advice: no record → no advice");
  check(pricingAdvice({}) === null, "advice: a record with no type → no advice");
  check(
    pricingAdvice({ type: "surge" }) === null,
    "advice: an unknown type → no advice rather than a wrong default",
  );

  // Every committed record must resolve, or a surface silently loses its badge.
  for (const [agencyId, pricing] of Object.entries(OPERATOR_PRICING)) {
    check(
      pricingAdvice(pricing) !== null,
      `operator-pricing ${agencyId}: type "${pricing.type}" resolves to no advice`,
    );
  }

  // costAnswer must be built FROM pricingAdvice, not a second copy of it.
  for (const type of ["dynamic", "fixed"]) {
    check(
      costAnswer({ pricingType: type, operatorNames: "X" }).includes(
        pricingAdvice({ type }).detail,
      ),
      `cost/${type}: the FAQ prose must reuse pricingAdvice().detail verbatim`,
    );
  }

  // A hub answers for many routes; the caller says so rather than rewriting.
  const many = costAnswer({ pricingType: "fixed", operatorNames: "PKP", scope: "routes" });
  check(many.includes("these routes"), "cost/scope: 'routes' pluralises the subject");
  check(
    costAnswer({ pricingType: "fixed", scope: "routes" }).startsWith("These routes are sold"),
    "cost/scope: pluralises the no-operator subject too",
  );
}

// ── Last-minute deals are half the advice, not a footnote ──────────────────
// This shipped broken twice, in opposite directions. First "Book early — fares
// rise as the train fills" rendered three lines under European Sleeper's own
// "Last-minute deals" link, so the page argued with itself. Then the late
// option was bolted on as a "but", which still led with "Book early" and
// understated it: a berth unsold the week before can be the cheapest fare on
// the train. Yield management is cheap at BOTH ends and dearest in between.
{
  const plain = pricingAdvice({ type: "dynamic" });
  const deals = pricingAdvice({ type: "dynamic" }, { hasLastMinuteDeals: true });

  // The contract: an operator that advertises last-minute deals must never be
  // given advice that says only "book early".
  check(
    /last.?minute|just before|close to departure/i.test(
      `${deals.guidance} ${deals.short} ${deals.detail}`,
    ),
    `deals: the advice must offer the late option — got "${deals.guidance} — ${deals.short}"`,
  );
  check(
    deals.guidance !== plain.guidance,
    "deals: the guidance itself must differ, not just the explanation below it",
  );
  check(
    /\bor\b/i.test(deals.guidance),
    `deals: the two strategies are alternatives, not one plus a caveat — got "${deals.guidance}"`,
  );
  // Without evidence of a programme we must not invent one.
  check(
    !/last.?minute/i.test(`${plain.guidance} ${plain.short} ${plain.detail}`),
    "deals: no known programme → no late option invented",
  );

  // The base wording must not claim prices only ever rise — the exact sentence
  // that contradicted the deals link the first time round.
  for (const a of [plain, deals]) {
    check(
      !/rise as the train fills|prices rise|only.*rise/i.test(`${a.short} ${a.detail}`),
      `deals: dynamic wording must not claim the price only ever rises — "${a.short}"`,
    );
  }
  check(
    /limited|go first|quota/i.test(plain.short),
    "deals: plain dynamic should rest on the quota selling out, which stays true either way",
  );
  // Cheap at both ends is the whole point; saying so needs both halves.
  check(
    /both ends|in between/i.test(`${deals.short} ${deals.detail}`),
    "deals: must say where the EXPENSIVE window is, or 'either end' is not actionable",
  );

  check(
    !/rise closer to departure/i.test(costAnswer({ fromPrice: "from €39", pricingType: "dynamic" })),
    "deals: the priced answer must not claim prices only rise",
  );

  // End to end: the FAQ for an operator with a deals page carries it.
  const answer = costAnswer({
    pricingType: "dynamic",
    operatorNames: "European Sleeper",
    hasLastMinuteDeals: true,
  });
  check(answer.includes(deals.detail), "deals: FAQ carries the both-ends explanation");

  // Every operator that advertises a deals link must be able to produce it.
  for (const [agencyId, booking] of Object.entries(OPERATOR_BOOKING)) {
    if (!booking.dealsUrl) continue;
    const pricing = OPERATOR_PRICING[agencyId];
    check(
      !!pricing,
      `${agencyId} links "${booking.dealsLabel}" but has no operator-pricing record, so its CTA says nothing about timing`,
    );
    if (!pricing) continue;
    const advice = pricingAdvice(pricing, { hasLastMinuteDeals: true });
    check(
      advice && /last.?minute|just before|close to departure/i.test(
        `${advice.guidance} ${advice.short} ${advice.detail}`,
      ),
      `${agencyId} links "${booking.dealsLabel}" next to advice that never mentions the late option`,
    );
  }
}

// ── A price has to carry its date ──────────────────────────────────────────
// build-initial-data was dropping the probe's sampledAt, so nothing downstream
// could say how old a figure was. That matters most for a hand-entered static
// price: "from €29" with no date cannot be told apart from the same number
// typed two years ago, and a fare that has moved since makes the page wrong
// rather than merely stale.
{
  check(
    formatCheckedAt("2026-09-11T07:00:00Z") === "Checked September 2026",
    `formatCheckedAt: got "${formatCheckedAt("2026-09-11T07:00:00Z")}"`,
  );
  // Month precision on purpose — a to-the-day stamp invites more trust than a
  // fare figure deserves.
  check(
    !/\b11\b/.test(formatCheckedAt("2026-09-11T07:00:00Z")),
    "formatCheckedAt must not imply day-level precision",
  );
  // A date near midnight UTC must not slip a month via the local timezone.
  check(
    formatCheckedAt("2026-10-01T00:30:00Z").includes("October"),
    `formatCheckedAt must read the date in UTC, got "${formatCheckedAt("2026-10-01T00:30:00Z")}"`,
  );
  for (const bad of [null, undefined, "", "not-a-date", 0]) {
    check(
      formatCheckedAt(bad) === "",
      `formatCheckedAt(${JSON.stringify(bad)}) must render nothing rather than "Invalid Date"`,
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error(`✗ verify-seo-faq: ${problems.length} problem(s)`);
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}
console.log("✓ verify-seo-faq: all checks passed");
