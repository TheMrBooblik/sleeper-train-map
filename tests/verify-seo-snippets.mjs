#!/usr/bin/env node
/**
 * The connection-page snippets.
 *
 * Two things here are load-bearing and neither is visible by reading a page.
 *
 * The CONTROL variant renders nowhere, and still has to reproduce the templates
 * the pages carried before this change, byte for byte. It is the baseline the
 * before/after report measures against and the wording a revert restores, so if
 * it drifts there is no longer any record of what the pages used to say. The
 * templates are restated below rather than imported: two independent
 * expressions of the same string, so a typo in either one fails.
 *
 * And `intro` — the page's visible opening paragraph — must NOT be the meta
 * description. That description now opens "Nightjet NJ 466 leaves Vienna
 * 19:39…", which is a snippet and not an opening sentence; the page renders one
 * of the two in its <header> and it has to be the prose.
 *
 * Assertions run against the published payload rather than a fixture, for the
 * reason `verify-station-times` does: the failure mode is a real route with a
 * missing field, and no fixture predicts which.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { getPublishedPairs } from "../scripts/lib/published-pairs.mjs";
import {
  CONTROL,
  FACTS,
  classesPhrase,
  connectionSnippet,
  durationForDirection,
  frequencyPhrase,
  pickPrimaryDirection,
} from "../src/lib/seo/snippet.mjs";
import { durationIsImplausible, greatCircleKm } from "../src/lib/durationPlausibility.mjs";
import { benchmarkCtr, winnableClicks } from "../src/lib/seo/ctrBenchmark.mjs";

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

// --- the previous templates, restated ---------------------------------

const legacyTitle = (cityA, cityB) =>
  `Night Trains ${cityA} to ${cityB} — Times, Stops & Tickets | Pingwi`;

const legacyDescription = ({ cityA, cityB, trainCount, operatorNames, fromPrice }) =>
  `${trainCount} night ${trainCount === 1 ? "train connects" : "trains connect"} ${cityA} and ${cityB}` +
  (operatorNames ? `, run by ${operatorNames}.` : ".") +
  (fromPrice
    ? ` Tickets ${fromPrice}. Timetables, stops, journey time and where to book.`
    : " Compare timetables, stops, journey time and where to book.");

const pairs = getPublishedPairs();
const baseline = JSON.parse(fs.readFileSync("data/seo/snippet-baseline.json", "utf8"));

console.log(`\nseo snippets — ${pairs.length} published pairs\n`);

// --- 1. parity --------------------------------------------------------------

check("control reproduces the templates the pages shipped with before", () => {
  assert.ok(pairs.length >= 200, `expected the full pair set, got ${pairs.length}`);
  for (const p of pairs) {
    const got = connectionSnippet({ ...p, variant: CONTROL });
    assert.equal(got.title, legacyTitle(p.cityA, p.cityB), `title drifted on ${p.slug}`);
    assert.equal(got.description, legacyDescription(p), `description drifted on ${p.slug}`);
  }
});

check("control parity holds for the price branch that has never yet fired", () => {
  // 0 of 293 routes carry a price today, so the published pairs cannot exercise
  // this and it would rot unnoticed until the day a probe produces a figure.
  const priced = { cityA: "Vienna", cityB: "Zurich", trainCount: 2, operatorNames: "ÖBB", fromPrice: "from €39", directions: [] };
  assert.equal(connectionSnippet({ ...priced, variant: CONTROL }).description, legacyDescription(priced));
  assert.match(connectionSnippet({ ...priced, variant: FACTS }).description, /Tickets from €39\./);
});

// --- 2. invariance ----------------------------------------------------------

check("intro is the prose, not the meta description, on every pair", () => {
  for (const p of pairs) {
    const control = connectionSnippet({ ...p, variant: CONTROL });
    const facts = connectionSnippet({ ...p, variant: FACTS });
    assert.equal(facts.intro, control.intro, `intro moved with the variant on ${p.slug}`);
    assert.equal(control.intro, control.description, `control intro must be its own description (${p.slug})`);
  }
});

check("the page renders intro in its header, and ships FACTS", () => {
  // The defect is structural and the component's extensionless imports will not
  // load in raw node, so the source is what there is to assert — the same
  // reason verify-via-schedule pins the panel's chain order.
  const page = fs.readFileSync("src/pages/connections/[pair].js", "utf8");
  const header = page.slice(page.indexOf("<header"), page.indexOf("</header>"));
  assert.ok(header.includes("{intro}"), "the header paragraph must render {intro}");
  assert.ok(!header.includes("{description}"), "the header paragraph must not render {description}");
  assert.match(page, /variant:\s*FACTS/, "every pair page must render the FACTS variant");
});

// --- 3. length --------------------------------------------------------------

check("the shipped snippet stays inside the title and description budgets", () => {
  for (const p of pairs) {
    const { title, description } = connectionSnippet({ ...p, variant: FACTS });
    assert.ok(title.length <= TITLE_MAX, `${p.slug}: title ${title.length} > ${TITLE_MAX} — ${title}`);
    assert.ok(
      description.length <= DESCRIPTION_MAX,
      `${p.slug}: description ${description.length} > ${DESCRIPTION_MAX} — ${description}`,
    );
  }
});

check("the shipped variant earns its place: most titles carry a fact", () => {
  const withFact = pairs.filter((p) => !connectionSnippet({ ...p, variant: FACTS }).title.includes("Times, Stops & Tickets"));
  // 231 of 240 today. A change that drops this sharply has broken the data path
  // rather than the formula, and the pages would be reordered wording and
  // nothing else.
  assert.ok(
    withFact.length >= pairs.length * 0.8,
    `only ${withFact.length}/${pairs.length} titles carry a fact`,
  );
});

// --- 4. gating --------------------------------------------------------------

check("a clause never renders empty, dangling or double-punctuated", () => {
  const base = { cityA: "Vienna", cityB: "Zurich", trainCount: 1, operatorNames: "ÖBB" };
  const direction = {
    trainLabel: "NJ 466", operator: "ÖBB", origin: "Wien Hbf", destination: "Zürich HB",
    originCity: "Vienna", destinationCity: "Zurich", departure: "19:39", arrival: "08:20",
    serviceDays: "2026: Daily", stopCount: 12, durationText: "12h 41m", classes: "seat, couchette, sleeper",
  };
  const missing = ["departure", "arrival", "serviceDays", "durationText", "classes", "stopCount", "operator", "trainLabel"];
  // Every single-field hole, plus the all-empty row, plus no directions at all.
  const variants = [
    {}, ...missing.map((f) => ({ [f]: "" })),
    Object.fromEntries(missing.map((f) => [f, ""])),
  ];
  for (const hole of variants) {
    for (const directions of [[{ ...direction, ...hole }], []]) {
      const { title, description } = connectionSnippet({ ...base, directions, variant: FACTS });
      for (const [label, text] of [["title", title], ["description", description]]) {
        const where = `${label} with ${JSON.stringify(hole)}`;
        assert.ok(!/\s—\s*$/.test(text), `${where}: dangling em dash — ${text}`);
        assert.ok(!/,\s*[.,]/.test(text), `${where}: doubled punctuation — ${text}`);
        assert.ok(!/\s{2,}/.test(text), `${where}: doubled space — ${text}`);
        assert.ok(!/\b(undefined|null|NaN)\b/.test(text), `${where}: leaked value — ${text}`);
        assert.ok(!/(^|\s)[,.]/.test(text), `${where}: orphaned punctuation — ${text}`);
        assert.ok(text.trim().length > 0, `${where}: empty`);
      }
    }
  }
});

check("frequencyPhrase reads only what the calendar can prove", () => {
  const cases = [
    ["2026: Daily", "nightly"], ["Daily", "nightly"], ["", ""],
    ["2026/06/13-09/06: Daily", "nightly"], ["2026: Daily, except Sat", "nightly except Sat"],
    ["2026: Fri", "1× a week"], ["2026: Mon, Wed, Sat", "3× a week"],
    ["2026-06-01 – 2027-01-02: Mon, Fri", "2× a week"],
    // A cadence says how OFTEN and never WHICH nights — availabilityFor()
    // refuses to derive a weekday list from one, and so does this.
    ["2026: Every 2nd day", ""], ["2026: 2-3 times per week", ""],
    ["Postponed to 2027", ""],
  ];
  for (const [input, want] of cases) assert.equal(frequencyPhrase(input), want, `frequencyPhrase(${JSON.stringify(input)})`);
});

check("classesPhrase ranks berths for a traveller, not for the feed", () => {
  assert.equal(classesPhrase("seat, couchette, sleeper"), "Sleepers, couchettes and seats");
  assert.equal(classesPhrase("bunkbed, couchette, sleeper"), "Sleepers, couchettes and bunk beds");
  assert.equal(classesPhrase("seat, sleeper"), "Sleepers and seats");
  assert.equal(classesPhrase("sleeper"), "Sleepers");
  assert.equal(classesPhrase(""), "");
  assert.equal(classesPhrase("first class"), "");
});

check("a duration that contradicts its own clocks is withheld, not published", () => {
  // UZ 020 states 9h 54m against endpoint times reading 23:10 → 22:45. Printing
  // both puts two different journeys in one sentence.
  assert.equal(durationForDirection({ durationText: "9h 54m", departure: "23:10", arrival: "22:45" }), "");
  // Agreement inside an hour is the same number rounded differently.
  assert.equal(durationForDirection({ durationText: "12h 41m", departure: "19:39", arrival: "08:20" }), "12h 41m");
  // A gap of about a day is the clock wrapping on a journey longer than 24h —
  // the one case the trip is right and the clock is not.
  assert.equal(durationForDirection({ durationText: "23h 35m", departure: "23:10", arrival: "22:45" }), "23h 35m");
  // A synthetic row has no trip, so the clocks are all there is …
  assert.equal(durationForDirection({ durationText: "", departure: "19:39", arrival: "08:36" }), "12h 57m");
  // … but never below the four hours a sleeper leg takes, because that is the
  // shape every >24h wrap arrives in.
  assert.equal(durationForDirection({ durationText: "", departure: "18:25", arrival: "21:45" }), "");
});

check("no pair publishes a journey time the ground disproves", () => {
  // The regression this exists for: 14 of 240 pairs stated a duration a train
  // cannot achieve, because a >24h journey wrapped and the remainder cleared
  // the four-hour floor. /connections/chicago-to-emeryville put the California
  // Zephyr's 2 971 km at 5h 31m — 539 km/h — in its own title.
  const minutes = (text) => {
    const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(String(text || "").trim());
    return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : 0;
  };
  const guilty = [];
  for (const p of pairs) {
    const primary = pickPrimaryDirection(p.cityA, p.directions);
    const stated = durationForDirection(primary);
    if (!stated) continue;
    const km = greatCircleKm(primary.originPos, primary.destinationPos);
    if (durationIsImplausible(km, minutes(stated))) guilty.push(`${p.slug} (${stated})`);
  }
  assert.deepEqual(guilty, [], `implausible durations published: ${guilty.join(", ")}`);
});

check("the speed gate withholds a wrapped duration a floor would pass", () => {
  const chicago = [41.878, -87.629];
  const emeryville = [37.831, -122.287];
  // 2 907 km in 5h 31m. Well clear of MIN_CLOCK_MINUTES, and impossible.
  assert.equal(
    durationForDirection({
      departure: "11:08",
      arrival: "16:39",
      originPos: chicago,
      destinationPos: emeryville,
    }),
    "",
  );
  // The same clocks over a distance a sleeper really can cover are kept.
  assert.equal(
    durationForDirection({
      departure: "11:08",
      arrival: "16:39",
      originPos: [48.208, 16.372],
      destinationPos: [47.377, 8.54],
    }),
    "5h 31m",
  );
  // A stale TRIP duration is checked the same way — it can be a day out too.
  assert.equal(
    durationForDirection({ durationText: "5h 31m", originPos: chicago, destinationPos: emeryville }),
    "",
  );
  // With no coordinates there is nothing to disprove it, so it stands.
  assert.equal(durationForDirection({ durationText: "5h 31m" }), "5h 31m");
});

check("a corridor with several trains says so, and one train does not", () => {
  const base = {
    cityA: "Vienna",
    cityB: "Zurich",
    operatorNames: "ÖBB",
    directions: [
      {
        trainLabel: "NJ 466", operator: "ÖBB", origin: "Wien Hbf", destination: "Zürich HB",
        originCity: "Vienna", destinationCity: "Zurich", departure: "19:39", arrival: "08:20",
        serviceDays: "2026: Daily", stopCount: 12, durationText: "12h 41m", classes: "",
      },
    ],
  };
  const one = connectionSnippet({ ...base, trainCount: 1, variant: FACTS }).description;
  const three = connectionSnippet({ ...base, trainCount: 3, variant: FACTS }).description;
  assert.ok(!/trains on this route/.test(one), `single-train pair claimed a count: ${one}`);
  assert.match(three, /3 trains on this route\./);
  // It is the softest clause, so it is the first one shed when space runs out.
  const long = connectionSnippet({
    ...base,
    cityA: "Bruxelles-Midi/Brussel-Zuid",
    cityB: "Milano Porta Garibaldi",
    trainCount: 3,
    operatorNames: "European Sleeper, Trenitalia, ÖBB Nightjet",
    directions: [{ ...base.directions[0], classes: "seat, couchette, sleeper", stopCount: 22 }],
    variant: FACTS,
  }).description;
  assert.ok(long.length <= 160, `over budget: ${long.length}`);
});

check("the described direction is the one the title names", () => {
  const forward = { originCity: "Vienna", trainLabel: "A", departure: "19:39", arrival: "08:20", stopCount: 3 };
  const back = { originCity: "Zurich", trainLabel: "B", departure: "20:40", arrival: "06:51", stopCount: 9 };
  // Even though the return leg has the fuller stop list.
  assert.equal(pickPrimaryDirection("Vienna", [back, forward]).trainLabel, "A");
  // A direction with no clock loses to one that has them.
  const untimed = { originCity: "Vienna", trainLabel: "C", departure: "", arrival: "", stopCount: 40 };
  assert.equal(pickPrimaryDirection("Vienna", [untimed, forward]).trainLabel, "A");
  assert.equal(pickPrimaryDirection("Vienna", []), null);
});

// --- 5. the frozen baseline -------------------------------------------------

check("the baseline covers every published pair", () => {
  const slugs = new Set(pairs.map((p) => p.slug));
  const recorded = Object.keys(baseline.pages);
  assert.equal(recorded.length, slugs.size, "the baseline and the published pairs are different sizes");
  for (const slug of recorded) assert.ok(slugs.has(slug), `${slug} is in the baseline but not published`);
  // A pair with no row has no "before", so it silently drops out of the report.
  for (const slug of slugs) assert.ok(baseline.pages[slug], `${slug} is published but absent from the baseline`);
});

check("the baseline is a frozen snapshot, not a live count", () => {
  for (const [slug, page] of Object.entries(baseline.pages)) {
    for (const field of ["clicks", "impressions", "position"]) {
      assert.equal(typeof page[field], "number", `${slug}.${field} is not a number`);
      assert.ok(page[field] >= 0, `${slug}.${field} is negative`);
    }
    // `group` is what the abandoned split wrote. Its presence means somebody
    // reseeded from a file that still carried the arms.
    assert.ok(!("group" in page), `${slug} still carries an experiment arm`);
  }
  assert.match(baseline.shippedAt, /^\d{4}-\d{2}-\d{2}$/, "shippedAt must be a plain date");
  assert.match(baseline.sitemapBatchFlippedAt, /^\d{4}-\d{2}-\d{2}$/, "sitemapBatchFlippedAt must be a plain date");
  assert.ok(
    baseline.baselineWindow.from < baseline.baselineWindow.to,
    "the baseline window runs backwards",
  );
});

check("the benchmark curve ranks a bad position below a good one", () => {
  // The report bands on this, so a curve that stopped descending would let a
  // page nothing could win dilute the pages a title can move.
  for (let p = 2; p <= 60; p += 1) {
    assert.ok(benchmarkCtr(p) <= benchmarkCtr(p - 1), `CTR at ${p} exceeds ${p - 1}`);
  }
  assert.ok(benchmarkCtr(1) > benchmarkCtr(10), "position 1 must beat position 10");
  assert.equal(winnableClicks({ impressions: 1000, position: 1 }), 280);
  // aurillac-to-paris: 660 impressions at position 65 is worth a third of a click.
  assert.ok(winnableClicks({ impressions: 660, position: 65 }) < 1);
  assert.equal(winnableClicks({}), 0);
});

console.log(`\n${checks} checks passed\n`);
