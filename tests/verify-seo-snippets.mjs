#!/usr/bin/env node
/**
 * The connection-page snippets, rolled out in stages.
 *
 * Three things here are load-bearing and none is visible by reading a page.
 *
 * The rollout gate: FACTS renders only on the corridors `snippetVariantFor()`
 * names (European Sleeper's, to start), and EVERY other page renders CONTROL —
 * the templates the pages carried before, byte for byte. That is both the
 * promise that the rest of the site is untouched and the control group the
 * report reads the treatment against. The templates are restated below rather
 * than imported: two independent expressions of the same string, so a typo in
 * either one fails.
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

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { getPublishedPairs } from "../scripts/lib/published-pairs.mjs";
import {
  CONTROL,
  FACTS,
  FACTS_AGENCIES,
  classesPhrase,
  connectionSnippet,
  directionFrequency,
  durationForDirection,
  frequencyPhrase,
  labelDays,
  pickPrimaryDirection,
  snippetVariantFor,
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
/** A fixed build date, so a check never starts failing on the calendar. */
const TODAY = "2026-10-01";
/** The European Sleeper corridors in the published payload: the first rollout. */
const ES_PAIRS = ["amsterdam-to-milan", "berlin-to-paris", "brussels-to-milan", "brussels-to-prague"];
/** SNCF's Intercités de Nuit corridors: the second stage (October 2026). */
const SNCF_PAIRS = [
  "albi-to-paris", "aurillac-to-paris", "briancon-to-paris", "cerbere-to-paris", "latour-de-carol-to-paris",
  "nice-to-paris", "paris-to-rodez", "paris-to-tarbes", "paris-to-toulouse",
];
/** Trenitalia's Intercity Notte corridors: the third stage (October 2026). */
const FS_PAIRS = [
  "bolzano-to-rome", "catania-to-milan", "catania-to-rome", "lecce-to-milan", "lecce-to-rome", "lecce-to-turin",
  "milan-to-palermo", "palermo-to-rome", "reggio-calabria-to-turin", "rome-to-trieste", "salerno-to-turin",
];
const TREATED_PAIRS = [...ES_PAIRS, ...SNCF_PAIRS, ...FS_PAIRS].sort();
/**
 * Treated pages that did not exist when the baseline was taken: the Sicilian
 * through trains became their own corridors when the timetable moved to
 * Trenitalia's GTFS (they ran to Siracusa, and Viaggiatreno saw the Palermo
 * portions as Messina stubs), and Roma–Palermo ICN 1956/1959 was never on the
 * map at all. The report sits them out, having no "before" to compare.
 */
const TREATED_SINCE_BASELINE = ["catania-to-milan", "catania-to-rome", "milan-to-palermo", "palermo-to-rome"];

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

check("control parity holds for the price branch", () => {
  // European Sleeper's, Trenitalia's and 12306's rows carry a price, so the
  // published pairs exercise it; the synthetic case keeps it covered whatever
  // the night's data holds.
  assert.ok(pairs.some((p) => p.fromPrice), "no published pair carries a price");
  const priced = { cityA: "Vienna", cityB: "Zurich", trainCount: 2, operatorNames: "ÖBB", fromPrice: "from €39", directions: [] };
  assert.equal(connectionSnippet({ ...priced, variant: CONTROL }).description, legacyDescription(priced));
  assert.match(connectionSnippet({ ...priced, variant: FACTS }).description, /Tickets from €39\./);
});

// --- 2. invariance ----------------------------------------------------------

check("intro is the prose, not the meta description, on every pair", () => {
  for (const p of pairs) {
    const control = connectionSnippet({ ...p, variant: CONTROL });
    const facts = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    assert.equal(facts.intro, control.intro, `intro moved with the variant on ${p.slug}`);
    assert.equal(control.intro, control.description, `control intro must be its own description (${p.slug})`);
  }
});

check("the page renders intro in its header, and takes its variant from the gate", () => {
  // The defect is structural and the component's extensionless imports will not
  // load in raw node, so the source is what there is to assert — the same
  // reason verify-via-schedule pins the panel's chain order.
  const page = fs.readFileSync("src/pages/connections/[pair].js", "utf8");
  const header = page.slice(page.indexOf("<header"), page.indexOf("</header>"));
  assert.ok(header.includes("{intro}"), "the header paragraph must render {intro}");
  assert.ok(!header.includes("{description}"), "the header paragraph must not render {description}");
  assert.match(
    page,
    /variant:\s*snippetVariantFor\(/,
    "the pair page must pick its variant through snippetVariantFor(), the gate the report reads",
  );
  assert.ok(!/variant:\s*FACTS\b/.test(page), "a hard-coded FACTS would ship the snippet to every pair");
});

// --- 2b. the rollout gate ---------------------------------------------------

check("the sitemap ships every page in the rollout, through the same gate", () => {
  // The sitemap lambda imports data.js, which does not load in raw node, so its
  // source is what there is to assert. Brussels–Prague was in no sitemap before
  // this: rank 88 of a batch-1 cut at 80.
  const sitemap = fs.readFileSync("src/pages/sitemap.xml.js", "utf8");
  assert.match(sitemap, /snippetVariantFor\(/, "the sitemap must read the rollout gate");
  assert.match(sitemap, /i < BATCH_1_CONNECTIONS \|\| inRollout\(pair\)/, "batch 1 must keep the rollout's pages");
});

check("FACTS renders on exactly the European Sleeper, SNCF and Trenitalia corridors", () => {
  assert.deepEqual([...FACTS_AGENCIES], ["ES", "SNCF", "FS"]);
  const treated = pairs.filter((p) => snippetVariantFor(p.agencyIds) === FACTS).map((p) => p.slug);
  assert.deepEqual(treated, TREATED_PAIRS);
  // A compound id counts by its parts, as everywhere else in the repo.
  assert.equal(snippetVariantFor(["MÁV", "ES"]), FACTS);
  assert.equal(snippetVariantFor(["ÖBB"]), CONTROL);
  assert.equal(snippetVariantFor([]), CONTROL);
});

check("every other page renders its old wording, byte for byte", () => {
  let untouched = 0;
  for (const p of pairs) {
    if (snippetVariantFor(p.agencyIds) === FACTS) continue;
    const got = connectionSnippet({ ...p, variant: snippetVariantFor(p.agencyIds), today: TODAY });
    assert.equal(got.title, legacyTitle(p.cityA, p.cityB), `title changed on ${p.slug}`);
    assert.equal(got.description, legacyDescription(p), `description changed on ${p.slug}`);
    untouched += 1;
  }
  assert.equal(untouched, pairs.length - TREATED_PAIRS.length);
});

check("each European Sleeper page names its train and clock, and none invents one", () => {
  for (const slug of ES_PAIRS) {
    const p = pairs.find((x) => x.slug === slug);
    const { title, description } = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    assert.ok(title !== legacyTitle(p.cityA, p.cityB), `${slug} still carries the old title`);
    // Amsterdam–Milan has never run ("Postponed to 2027") and states 00:00 at
    // both ends; the first cut printed "leaves Amsterdam 00:00 and reaches
    // Milan 00:00 — 24h".
    assert.ok(!/(\d{2}:\d{2}) and reaches .* \1\b/.test(description), `${slug}: placeholder clocks — ${description}`);
    assert.ok(!/\b24h\b/.test(`${title} ${description}`), `${slug}: a 24h journey — ${title} / ${description}`);
    const timed = p.directions.some((d) => d.departure && d.arrival && d.departure !== d.arrival);
    if (timed) assert.match(description, /^European Sleeper ES \d+ leaves /, `${slug}: ${description}`);
  }
});

check("each SNCF page names its Intercités de Nuit and its clock", () => {
  for (const slug of SNCF_PAIRS) {
    const p = pairs.find((x) => x.slug === slug);
    assert.ok(p, `${slug} is not a published pair`);
    const { title, description } = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    assert.ok(title !== legacyTitle(p.cityA, p.cityB), `${slug} still carries the old title`);
    assert.match(description, /^SNCF IC Nuit \d+/, `${slug}: ${description}`);
    assert.match(description, / leaves .+ \d{2}:\d{2} and reaches .+ \d{2}:\d{2}/, `${slug}: ${description}`);
  }
});

check("each Trenitalia page names its Intercity Notte by number, with its clock and price", () => {
  for (const slug of FS_PAIRS) {
    const p = pairs.find((x) => x.slug === slug);
    assert.ok(p, `${slug} is not a published pair`);
    const { title, description } = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    assert.ok(title !== legacyTitle(p.cityA, p.cityB), `${slug} still carries the old title`);
    // The number Trenitalia sells it under, never the file key a through-car
    // portion is told apart by ("ICN 1963 (Palermo)").
    assert.match(description, /^Trenitalia ICN \d+ leaves /, `${slug}: ${description}`);
    assert.match(description, / leaves .+ \d{2}:\d{2} and reaches .+ \d{2}:\d{2}/, `${slug}: ${description}`);
    assert.match(description, /Tickets from €\d/, `${slug}: ${description}`);
  }
});

check("a label naming its own days never sits beside a contradicting frequency", () => {
  // Back-on-Track labels SNCF's Albi portion "IC Nuit 3754 (Sun)" while the
  // row's service string says "Daily"; the first SNCF preview printed
  // "IC Nuit 3754 (Sun) … nightly".
  assert.deepEqual(labelDays("IC Nuit 3754 (Sun)"), ["Sun"]);
  assert.deepEqual(labelDays("IC Nuit 3789 (Fri, Sat)"), ["Fri", "Sat"]);
  assert.equal(labelDays("IC Nuit 3754"), null);
  assert.equal(labelDays("1003 (G)"), null);
  assert.equal(directionFrequency({ trainLabel: "IC Nuit 3754 (Sun)", serviceDays: "2026: Daily" }), "");
  assert.equal(directionFrequency({ trainLabel: "IC Nuit 3754 (Sun)", serviceDays: "2026: Sun" }), "1× a week");
  assert.equal(directionFrequency({ trainLabel: "NJ 466", serviceDays: "2026: Daily" }), "nightly");
  for (const p of pairs) {
    const { title, description } = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    const m = /^\S+ (.+?) leaves /.exec(description);
    const days = m && labelDays(m[1]);
    if (!days) continue;
    const said = frequencyPhrase(days.join(", "));
    for (const phrase of ["nightly", "× a week"]) {
      if (said.includes(phrase)) continue;
      assert.ok(!`${title} ${description}`.includes(phrase), `${p.slug}: "${m[1]}" beside "${phrase}" — ${description}`);
    }
  }
});

check("a punctuality figure stays on the page, not in the snippet", () => {
  // SNCF's AQST figure runs ~5 months behind and is often low; the page and
  // the FAQ carry it with its month, the meta description does not.
  const page = fs.readFileSync("src/pages/connections/[pair].js", "utf8");
  const snippetInput = page.slice(page.indexOf("const snippetDirections"), page.indexOf("const snippet = connectionSnippet"));
  assert.ok(!/punctuality/.test(snippetInput), "the snippet directions must not carry punctuality");
  for (const p of pairs) {
    const { description } = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    assert.ok(!/on time/.test(description), `${p.slug}: ${description}`);
  }
});

// --- 3. length --------------------------------------------------------------

check("FACTS stays inside the title and description budgets on every pair", () => {
  // Every pair, not only the treated ones, so widening the rollout is a
  // one-line change with nothing left to discover.
  for (const p of pairs) {
    const { title, description } = connectionSnippet({ ...p, variant: FACTS, today: TODAY });
    assert.ok(title.length <= TITLE_MAX, `${p.slug}: title ${title.length} > ${TITLE_MAX} — ${title}`);
    assert.ok(
      description.length <= DESCRIPTION_MAX,
      `${p.slug}: description ${description.length} > ${DESCRIPTION_MAX} — ${description}`,
    );
  }
});

check("FACTS earns its place: most titles would carry a fact", () => {
  const withFact = pairs.filter(
    (p) => !connectionSnippet({ ...p, variant: FACTS, today: TODAY }).title.includes("Times, Stops & Tickets"),
  );
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
      const { title, description } = connectionSnippet({ ...base, directions, variant: FACTS, today: TODAY });
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
    const primary = pickPrimaryDirection(p.cityA, p.directions, { today: TODAY });
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

check("placeholder clocks state no journey and no duration", () => {
  const placeholder = {
    trainLabel: "ES 454", operator: "European Sleeper", origin: "Amsterdam Centraal", destination: "Milano Centrale",
    originCity: "Amsterdam", destinationCity: "Milan", departure: "00:00", arrival: "00:00",
    serviceDays: "", stopCount: 11, durationText: "24h", classes: "seat, couchette, sleeper",
  };
  assert.equal(durationForDirection(placeholder), "");
  const { title, description } = connectionSnippet({
    cityA: "Amsterdam", cityB: "Milan", trainCount: 1, operatorNames: "European Sleeper",
    directions: [placeholder, { ...placeholder, origin: "Milano Centrale", destination: "Amsterdam Centraal", originCity: "Milan", destinationCity: "Amsterdam" }],
    variant: FACTS,
  });
  assert.equal(title, "Amsterdam to Milan Night Train — Times, Stops & Tickets");
  assert.match(description, /^1 night train connects Amsterdam and Milan, run by European Sleeper\./);
  assert.ok(!description.includes("00:00"), description);
});

check("a timetable that has not started is not the one described", () => {
  // Brussels–Milan carries December's timetable as its own row, with one stop
  // more; the first cut described it, with its December days.
  const running = { originCity: "Brussels", trainLabel: "ES 401", departure: "19:06", arrival: "11:40", stopCount: 11, serviceDays: "2026/10/01-12/10: Mon, Thu, Sat" };
  const preview = { ...running, stopCount: 12, serviceDays: "2026-12-13 – 2027-09-07: Tue, Thu, Sun" };
  assert.equal(pickPrimaryDirection("Brussels", [preview, running], { today: TODAY }).serviceDays, running.serviceDays);
  // A window opening tomorrow is the next run, not a future timetable: a feed
  // states its window from the next departure (ES 474 on 1 October: 10/02-).
  const tomorrow = { ...running, stopCount: 12, serviceDays: "2026/10/02-12/11: Mon, Wed, Fri" };
  assert.equal(pickPrimaryDirection("Brussels", [running, tomorrow], { today: TODAY }).serviceDays, tomorrow.serviceDays);
  // Without a build date nothing is upcoming — the old behaviour.
  assert.equal(pickPrimaryDirection("Brussels", [running, preview]).serviceDays, preview.serviceDays);
  // A corridor with nothing running yet still describes something.
  assert.equal(pickPrimaryDirection("Brussels", [preview], { today: TODAY }).serviceDays, preview.serviceDays);
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

check("the baseline has a 'before' for every treated page, and for most of the rest", () => {
  // A treated page with no row would silently drop out of the readout.
  for (const slug of TREATED_PAIRS) {
    if (TREATED_SINCE_BASELINE.includes(slug)) {
      assert.ok(!baseline.pages[slug], `${slug} is in the baseline after all — take it off TREATED_SINCE_BASELINE`);
      continue;
    }
    assert.ok(baseline.pages[slug], `${slug} is treated but absent from the baseline`);
  }
  // Pairs newer than the baseline (routes added since 2026-09-20) sit out of
  // the control group; the report says how many. Far fewer than half, or the
  // control stops describing the site. 80%: Thailand (October 2026) and
  // Vietnam (another 20 corridors) took the share from 0.93 to 0.88, and a
  // new country's pages are exactly the ones the baseline cannot have.
  const covered = pairs.filter((p) => baseline.pages[p.slug]).length;
  assert.ok(covered >= pairs.length * 0.8, `only ${covered}/${pairs.length} pairs have a baseline`);
});

check("the baseline is a frozen snapshot, not a live count", () => {
  for (const [slug, page] of Object.entries(baseline.pages)) {
    for (const field of ["clicks", "impressions", "position"]) {
      assert.equal(typeof page[field], "number", `${slug}.${field} is not a number`);
      assert.ok(page[field] >= 0, `${slug}.${field} is negative`);
    }
    // Arms are read from the gate at report time, never stored: a stored arm
    // would go stale the day the rollout widens.
    assert.ok(!("group" in page), `${slug} carries an experiment arm`);
  }
  for (const field of ["from", "to"]) {
    assert.match(baseline.baselineWindow[field], /^\d{4}-\d{2}-\d{2}$/, `baselineWindow.${field} must be a plain date`);
  }
  assert.ok(
    baseline.baselineWindow.from < baseline.baselineWindow.to,
    "the baseline window runs backwards",
  );
  // PR #88's draft recorded a ship date and a sitemap flip that never happened;
  // a baseline must not claim either.
  assert.ok(!("shippedAt" in baseline) && !("sitemapBatchFlippedAt" in baseline), "the baseline claims a launch");
});

check("the report reads its own baseline as no change, on both arms", () => {
  const csv = path.join(os.tmpdir(), `snippet-baseline-${process.pid}.csv`);
  const rows = Object.entries(baseline.pages).map(
    ([slug, p]) => `https://pingwi.com/connections/${slug},${p.clicks},${p.impressions},0%,${p.position}`,
  );
  fs.writeFileSync(csv, ["Top pages,Clicks,Impressions,CTR,Position", ...rows].join("\n"));
  try {
    const run = spawnSync(process.execPath, ["scripts/seo-snippet-report.mjs", csv], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /treatment 1\.00×, control 1\.00× → net 1\.00×/, run.stdout);
    // A control page that gained a price is not a control: it is read apart,
    // and the control row holds only unpriced pages.
    // A page with no train running now leads with the next season under
    // either variant, so it is neither arm either.
    const seasonal = pairs.filter((p) => baseline.pages[p.slug] && p.upcoming);
    if (seasonal.length) {
      assert.match(run.stdout, new RegExp(`seasonal\\s+before\\s+${seasonal.length}\\s`), run.stdout);
    }
    const priced = pairs.filter(
      (p) => baseline.pages[p.slug] && !p.upcoming && p.fromPrice && snippetVariantFor(p.agencyIds) !== FACTS,
    );
    assert.ok(priced.length > 0, "the published pairs carry priced control-variant pages");
    assert.match(run.stdout, new RegExp(`${priced.length} control page\\(s\\) gained a price`), run.stdout);
    assert.match(run.stdout, new RegExp(`priced\\s+before\\s+${priced.length}\\s`), run.stdout);
    const unpriced = pairs.filter(
      (p) => baseline.pages[p.slug] && !p.upcoming && !p.fromPrice && snippetVariantFor(p.agencyIds) !== FACTS,
    );
    assert.match(run.stdout, new RegExp(`control\\s+before\\s+${unpriced.length}\\s`), run.stdout);
    for (const slug of TREATED_PAIRS) {
      if (TREATED_SINCE_BASELINE.includes(slug)) continue; // no "before": sits out
      assert.ok(run.stdout.includes(slug), `${slug} missing from the treatment table`);
    }
  } finally {
    fs.rmSync(csv, { force: true });
  }
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
