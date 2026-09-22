#!/usr/bin/env node
/**
 * The connection-page snippet experiment.
 *
 * Two things here are load-bearing and neither is visible by reading a page.
 *
 * The CONTROL variant has to reproduce the templates the pages carried before
 * the experiment, byte for byte, or half the pages silently changed and the
 * arm they are supposed to anchor is not a baseline at all. The templates are
 * restated below rather than imported: two independent expressions of the same
 * string, so a typo in either one fails.
 *
 * And `intro` — the page's visible opening paragraph — must NOT move with the
 * meta description. The page renders one of them in its <header>, and if that
 * is the varying one then the treatment arm changed its body text too, the
 * rankings move with it, and the CTR readout means nothing.
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
import {
  CONTROL_GROUP,
  TREATMENT_GROUP,
  assignGroups,
} from "../src/lib/seo/experiment-split.mjs";
import { variantFor } from "../src/lib/seo/experiment.mjs";

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

// --- the pre-experiment templates, restated ---------------------------------

const legacyTitle = (cityA, cityB) =>
  `Night Trains ${cityA} to ${cityB} — Times, Stops & Tickets | Pingwi`;

const legacyDescription = ({ cityA, cityB, trainCount, operatorNames, fromPrice }) =>
  `${trainCount} night ${trainCount === 1 ? "train connects" : "trains connect"} ${cityA} and ${cityB}` +
  (operatorNames ? `, run by ${operatorNames}.` : ".") +
  (fromPrice
    ? ` Tickets ${fromPrice}. Timetables, stops, journey time and where to book.`
    : " Compare timetables, stops, journey time and where to book.");

const pairs = getPublishedPairs();
const experiment = JSON.parse(fs.readFileSync("data/seo/snippet-experiment.json", "utf8"));

console.log(`\nseo snippets — ${pairs.length} published pairs\n`);

// --- 1. parity --------------------------------------------------------------

check("control reproduces the pre-experiment templates on every pair", () => {
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

check("intro is identical under both variants, on every pair", () => {
  for (const p of pairs) {
    const control = connectionSnippet({ ...p, variant: CONTROL });
    const facts = connectionSnippet({ ...p, variant: FACTS });
    assert.equal(facts.intro, control.intro, `intro moved with the variant on ${p.slug}`);
    assert.equal(control.intro, control.description, `control intro must be its own description (${p.slug})`);
  }
});

check("the page renders intro, not description, in its header", () => {
  // The defect is structural and the component's extensionless imports will not
  // load in raw node, so the source is what there is to assert — the same
  // reason verify-via-schedule pins the panel's chain order.
  const page = fs.readFileSync("src/pages/connections/[pair].js", "utf8");
  const header = page.slice(page.indexOf("<header"), page.indexOf("</header>"));
  assert.ok(header.includes("{intro}"), "the header paragraph must render {intro}");
  assert.ok(!header.includes("{description}"), "the header paragraph must not render {description}");
});

// --- 3. length --------------------------------------------------------------

check("treatment stays inside the title and description budgets", () => {
  for (const p of pairs) {
    const { title, description } = connectionSnippet({ ...p, variant: FACTS });
    assert.ok(title.length <= TITLE_MAX, `${p.slug}: title ${title.length} > ${TITLE_MAX} — ${title}`);
    assert.ok(
      description.length <= DESCRIPTION_MAX,
      `${p.slug}: description ${description.length} > ${DESCRIPTION_MAX} — ${description}`,
    );
  }
});

check("treatment earns its place: most pages carry a fact the control did not", () => {
  const withFact = pairs.filter((p) => !connectionSnippet({ ...p, variant: FACTS }).title.includes("Times, Stops & Tickets"));
  // 231 of 240 today. A change that drops this sharply has broken the data path
  // rather than the formula, and the experiment would measure a reordering.
  assert.ok(
    withFact.length >= pairs.length * 0.8,
    `only ${withFact.length}/${pairs.length} treatment titles carry a fact`,
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

// --- 5. assignment integrity ------------------------------------------------

check("the committed split covers every published pair, disjointly", () => {
  const slugs = new Set(pairs.map((p) => p.slug));
  const assigned = Object.keys(experiment.pages);
  assert.equal(assigned.length, slugs.size, "the split and the published pairs are different sizes");
  for (const slug of assigned) assert.ok(slugs.has(slug), `${slug} is in the split but not published`);
  for (const slug of slugs) assert.ok(experiment.pages[slug], `${slug} is published but not in the split`);
  for (const [slug, page] of Object.entries(experiment.pages)) {
    assert.ok(
      page.group === TREATMENT_GROUP || page.group === CONTROL_GROUP,
      `${slug} has group ${JSON.stringify(page.group)}`,
    );
  }
});

check("the committed split is still what the rule produces from its own baseline", () => {
  const recomputed = assignGroups(experiment.pages);
  for (const [slug, page] of Object.entries(experiment.pages)) {
    assert.equal(recomputed.get(slug), page.group, `${slug} has drifted from the assignment rule`);
  }
});

check("the arms are matched on volume", () => {
  const arm = (group) => Object.values(experiment.pages).filter((p) => p.group === group);
  const impressions = (group) => arm(group).reduce((n, p) => n + p.impressions, 0);
  const t = arm(TREATMENT_GROUP);
  const c = arm(CONTROL_GROUP);
  assert.ok(Math.abs(t.length - c.length) <= 1, `arm sizes ${t.length} vs ${c.length}`);
  const skew = Math.abs(impressions(TREATMENT_GROUP) - impressions(CONTROL_GROUP)) /
    Math.max(impressions(TREATMENT_GROUP) + impressions(CONTROL_GROUP), 1);
  assert.ok(skew <= 0.02, `baseline impressions are ${(100 * skew).toFixed(1)}% apart between arms`);
});

check("variantFor enrols only what the committed file names", () => {
  const treated = Object.entries(experiment.pages).find(([, p]) => p.group === TREATMENT_GROUP)[0];
  const held = Object.entries(experiment.pages).find(([, p]) => p.group === CONTROL_GROUP)[0];
  assert.equal(variantFor(treated), FACTS);
  assert.equal(variantFor(held), CONTROL);
  // A pair published after the split was frozen has no baseline to be measured
  // against, so it must never be enrolled by accident.
  assert.equal(variantFor("a-pair-that-does-not-exist"), CONTROL);
  assert.equal(variantFor(undefined), CONTROL);
});

console.log(`\n${checks} checks passed\n`);
