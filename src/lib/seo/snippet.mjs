/**
 * Titles and meta descriptions for the `/connections/{pair}` pages.
 *
 * Three months of Search Console said the pair pages rank and are not clicked:
 * in positions 5-20, where clicks are winnable, 45 clicks from 7 276
 * impressions (0.62%) against a 2-5% benchmark, with
 * /connections/venice-to-vienna at position 10.5 on 690 impressions and ONE
 * click. Every title and description was a template carrying no fact a searcher
 * wants, while the facts sat one field away: duration on 398/398 trips,
 * departure and arrival on every top-impression page, operating days on 450/547
 * directions, and `classes` — sleeper / couchette / seat — on 396 of 398 trips,
 * printed in RouteFactsGrid and never once in a snippet.
 *
 * `FACTS` is what every pair page renders. It puts the query entity first with
 * one number in the title, and opens the description with the train, its clock
 * and how often it runs.
 *
 * `CONTROL` reproduces the old templates BYTE FOR BYTE and renders nowhere. It
 * is not dead weight: it is the baseline the before/after report measures
 * against, it supplies `intro` (below), and it is what a revert restores —
 * `verify-seo-snippets` pins it against every published pair, so "what the
 * pages used to say" cannot quietly drift.
 *
 * The module is dependency-free `.mjs` for the reason `slugify.mjs` and
 * `routeFaq.mjs` are: `verify-seo-snippets` must compute in raw node exactly
 * what the Next build computes, or the test pins nothing.
 */

import { durationIsImplausible, greatCircleKm } from "../durationPlausibility.mjs";

/** Variant ids. The pages pass FACTS; CONTROL is the pinned former wording. */
export const CONTROL = "control";
export const FACTS = "facts";

/** Google truncates around here on desktop, earlier on mobile. */
const TITLE_MAX = 60;
const BRAND = " | Pingwi";
/** A title longer than this cannot carry the brand and stay inside TITLE_MAX. */
const BRAND_BUDGET = TITLE_MAX - BRAND.length;
const DESCRIPTION_MAX = 160;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Strips a BoT validity prefix: "2026: Daily", "2026/06/13-09/06: Daily". */
const SERVICE_PREFIX_RE = /^\s*\d{4}(?:[/-][\d/-]+)?\s*(?:–\s*[\d-]+\s*)?:\s*/;

/**
 * How often the train runs, as a phrase a title can carry.
 *
 * Reads only what it can prove. A cadence string ("Every 2nd day", 50 legs)
 * says how OFTEN a train runs and never WHICH nights, and `availabilityFor()`
 * already refuses to derive a weekday list from one — so it yields nothing
 * here rather than a phrase the timetable does not support. An unparsed note
 * yields nothing for the same reason.
 *
 * @param {string} serviceDays rendered calendar, e.g. "2026: Daily"
 * @returns {string} "nightly" | "nightly except Sat" | "3× a week" | ""
 */
export function frequencyPhrase(serviceDays) {
  const raw = String(serviceDays || "").trim();
  if (!raw) return "";
  const days = raw.replace(SERVICE_PREFIX_RE, "").trim();
  if (!days) return "";

  if (days === "Daily") return "nightly";

  const except = /^Daily, except (\w{3})$/.exec(days);
  if (except && DAY_LABELS.includes(except[1])) return `nightly except ${except[1]}`;

  const listed = days.split(",").map((d) => d.trim());
  if (listed.length && listed.every((d) => DAY_LABELS.includes(d))) {
    return listed.length === 7 ? "nightly" : `${listed.length}× a week`;
  }
  return "";
}

/**
 * Journey length from the two endpoint clocks, in minutes, wrapping once past
 * midnight. Returns 0 when it cannot be read.
 *
 * @param {string} departure "HH:MM"
 * @param {string} arrival   "HH:MM"
 * @returns {number}
 */
function clockMinutes(departure, arrival) {
  const read = (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = read(departure);
  const to = read(arrival);
  if (from == null || to == null) return 0;
  const span = to - from;
  return span > 0 ? span : span + 1440;
}

/**
 * The shortest journey this module will state from two clocks alone.
 *
 * Two endpoint times cannot express more than a day, so a train longer than 24h
 * wraps and reads as a SHORT one — UZ 099 Kyiv to Bucharest is 23 hours and its
 * clocks say thirteen minutes. Every instance of that fault reads short, never
 * long, so refusing anything under the four hours `MIN_TRIP_MINUTES` already
 * uses for a sleeper leg rules the whole class out. The seven genuinely sub-4h
 * legs in the payload lose a duration they could have had, which is the safe
 * direction to miss in.
 */
const MIN_CLOCK_MINUTES = 240;

/** "12h 57m", matching formatDuration(), or "" when there is nothing to state. */
function formatMinutes(total) {
  if (!(total > 0)) return "";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * How far a stated duration may sit from the clocks before the two are treated
 * as contradicting each other rather than rounding differently.
 *
 * The trips table is the upstream Back-on-Track export and nothing in the
 * pipeline writes to it, so it goes stale independently of the times the
 * enrichment corrects — CLAUDE.md counts 18 directions where the two
 * disagree. Across the payload the gap is either a few minutes or almost
 * exactly a whole day, so an hour separates "same number" from "different
 * source" with nothing near the boundary.
 */
const DURATION_AGREEMENT_MINUTES = 60;
const ONE_DAY_MINUTES = 1440;

/**
 * How long the journey takes, as the snippet may state it.
 *
 * Three things can stop it stating one, and the third is the one a duration
 * floor cannot do on its own.
 *
 * The trip's own duration wins — it is what RouteFactsGrid prints, so the
 * snippet and the page cannot quote different numbers — but only while it
 * agrees with the clocks printed beside it. UZ 020 states 9h 54m against
 * endpoint times reading 23:10 to 22:45, and a description carrying both says
 * two different things in one sentence. A gap of about a day is the exception:
 * that is the clock wrapping on a journey longer than 24h, the one case the
 * trip is right and the clock is not.
 *
 * A synthetic row has no trip at all (93 of the 240 pairs) and the clocks are
 * the only evidence there is. Those are read above MIN_CLOCK_MINUTES — and
 * then only while the ground they cover does not disprove them, because the
 * floor alone is far too weak: a wrapped journey's remainder can be anything
 * up to 24h, and four hours let the California Zephyr publish 2 971 km in
 * 5h 31m, 539 km/h, in its own title. `durationIsImplausible` is the test that
 * scales, and it applies to a stated trip duration too — a stale one can be a
 * day out in exactly the same way.
 *
 * @param {{durationText?: string, departure?: string, arrival?: string,
 *          originPos?: [number, number], destinationPos?: [number, number]}} direction
 * @returns {string}
 */
export function durationForDirection(direction) {
  if (!direction) return "";

  const km = greatCircleKm(direction.originPos, direction.destinationPos);
  const clock = clockMinutes(direction.departure, direction.arrival);

  if (direction.durationText) {
    const stated = statedMinutes(direction.durationText);
    if (stated && durationIsImplausible(km, stated)) return "";
    if (!clock || !stated) return direction.durationText;
    const gap = Math.abs(stated - clock);
    const agrees = gap <= DURATION_AGREEMENT_MINUTES;
    const wrapped = Math.abs(gap - ONE_DAY_MINUTES) <= DURATION_AGREEMENT_MINUTES;
    return agrees || wrapped ? direction.durationText : "";
  }

  if (clock < MIN_CLOCK_MINUTES) return "";
  if (durationIsImplausible(km, clock)) return "";
  return formatMinutes(clock);
}

/** Minutes back out of a "12h 47m" / "9h" / "45m" string, or 0. */
function statedMinutes(text) {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(String(text || "").trim());
  if (!m || (!m[1] && !m[2])) return 0;
  return Number(m[1] || 0) * 60 + Number(m[2] || 0);
}

/** Accommodation words in the order a traveller ranks them, not the feed's. */
const CLASS_WORDS = [
  ["sleeper", "sleepers"],
  ["couchette", "couchettes"],
  ["bunkbed", "bunk beds"],
  ["seat", "seats"],
];

/**
 * The berth types as a sentence fragment: "Sleepers, couchettes and seats".
 *
 * This is the field the connection pages were sitting on and never said out
 * loud in a snippet — 396 of 398 trips carry it, and sleeper-vs-couchette is
 * the thing somebody booking a night train actually wants to know.
 *
 * @param {string} classes e.g. "seat, couchette, sleeper"
 * @returns {string} "" when nothing recognisable is present
 */
export function classesPhrase(classes) {
  const tokens = String(classes || "")
    .toLowerCase()
    .split(",")
    .map((t) => t.trim());
  const words = CLASS_WORDS.filter(([key]) => tokens.includes(key)).map(([, label]) => label);
  if (!words.length) return "";
  const head = words.slice(0, -1);
  const sentence = head.length ? `${head.join(", ")} and ${words[words.length - 1]}` : words[0];
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The direction the snippet describes.
 *
 * Prefers one that states both a departure and an arrival, then one running
 * the way the title reads — a page headed "Vienna to Zurich" whose sentence
 * leaves Zurich reads as a mistake — then the fullest stop list, then the
 * train label so the choice is stable between builds.
 *
 * @param {string} cityA
 * @param {object[]} directions
 * @returns {object|null}
 */
export function pickPrimaryDirection(cityA, directions) {
  const all = Array.isArray(directions) ? directions.filter(Boolean) : [];
  if (!all.length) return null;
  const timed = all.filter((d) => d.departure && d.arrival);
  const pool = timed.length ? timed : all;
  const forward = pool.filter((d) => d.originCity && d.originCity === cityA);
  const pick = forward.length ? forward : pool;
  return (
    pick
      .slice()
      .sort(
        (a, b) =>
          (b.stopCount || 0) - (a.stopCount || 0) ||
          String(a.trainLabel || "").localeCompare(String(b.trainLabel || "")),
      )[0] || null
  );
}

/** The description every page carried before the experiment. */
function controlDescription({ cityA, cityB, trainCount, operatorNames, fromPrice }) {
  return (
    `${trainCount} night ${trainCount === 1 ? "train connects" : "trains connect"} ${cityA} and ${cityB}` +
    (operatorNames ? `, run by ${operatorNames}.` : ".") +
    (fromPrice
      ? ` Tickets ${fromPrice}. Timetables, stops, journey time and where to book.`
      : " Compare timetables, stops, journey time and where to book.")
  );
}

/** Entity first, one number, and the brand only while it fits. */
function factsTitle({ cityA, cityB, durationText, frequency }) {
  const base = `${cityA} to ${cityB} Night Train`;
  const facts = [durationText, frequency].filter(Boolean);

  let title = facts.length ? `${base} — ${facts.join(", ")}` : `${base} — Times, Stops & Tickets`;
  // Shed the softest fact first, then the tail, rather than letting Google cut
  // mid-word.
  if (title.length > TITLE_MAX && facts.length > 1) title = `${base} — ${facts[0]}`;
  if (title.length > TITLE_MAX) title = base;

  return title.length <= BRAND_BUDGET ? `${title}${BRAND}` : title;
}

/**
 * Lead with the train, its clock and how often it runs; keep the control
 * opener for a corridor whose trains state no times at all.
 */
function factsDescription({
  cityA,
  cityB,
  trainCount,
  operatorNames,
  fromPrice,
  primary,
  durationText,
  frequency,
}) {
  const lead =
    primary && primary.departure && primary.arrival
      ? [
          [primary.operator, primary.trainLabel].filter(Boolean).join(" "),
          `leaves ${primary.originCity || primary.origin} ${primary.departure} and reaches ${primary.destinationCity || primary.destination} ${primary.arrival}`,
        ]
          .filter(Boolean)
          .join(" ") +
        (durationText ? ` — ${durationText}` : "") +
        (frequency ? `, ${frequency}` : "") +
        "."
      : `${trainCount} night ${trainCount === 1 ? "train connects" : "trains connect"} ${cityA} and ${cityB}` +
        (operatorNames ? `, run by ${operatorNames}.` : ".");

  const classes = primary ? classesPhrase(primary.classes) : "";
  const stops = primary && primary.stopCount >= 3 ? primary.stopCount : 0;

  // `drop` is the order clauses are shed in when the description runs long.
  // The lead is never shed. The train count goes first: it is the softest of
  // the four, and on a single-train pair it is not emitted at all. Then the
  // berth types, then the tail — which carries the call to action — and a
  // price last, being the highest-intent fact on the page.
  const clauses = [
    { text: lead, drop: 0 },
    { text: trainCount > 1 ? `${trainCount} trains on this route.` : "", drop: 1 },
    { text: fromPrice ? `Tickets ${fromPrice}.` : "", drop: 4 },
    { text: classes ? `${classes}.` : "", drop: 2 },
    { text: stops ? `Full timetable, ${stops} stops and where to book.` : "Full timetable and where to book.", drop: 3 },
  ].filter((c) => c.text);

  let kept = clauses;
  for (const rank of [1, 2, 3, 4]) {
    if (kept.map((c) => c.text).join(" ").length <= DESCRIPTION_MAX) break;
    kept = kept.filter((c) => c.drop !== rank);
  }
  return kept.map((c) => c.text).join(" ");
}

/**
 * Title, meta description and the visible intro paragraph for a pair page.
 *
 * `intro` is the CONTROL description under both variants, and it is why the
 * page keeps reading like a page. The pair page rendered its meta description
 * as its visible opening paragraph; a description that now leads "Nightjet NJ
 * 466 leaves Vienna 19:39…" is a snippet and not an opening sentence, so the
 * prose and the meta part company here rather than in the component.
 *
 * @param {object} input
 * @param {string} input.cityA
 * @param {string} input.cityB
 * @param {number} input.trainCount
 * @param {string} [input.operatorNames] already joined, e.g. "ÖBB, SNCF"
 * @param {string} [input.fromPrice] already formatted, e.g. "from €39"
 * @param {object[]} [input.directions] every direction of every train on the pair
 * @param {string} [input.variant] CONTROL (default) or FACTS
 * @returns {{title: string, description: string, intro: string}}
 */
export function connectionSnippet({
  cityA,
  cityB,
  trainCount,
  operatorNames = "",
  fromPrice = "",
  directions = [],
  variant = CONTROL,
} = {}) {
  const intro = controlDescription({ cityA, cityB, trainCount, operatorNames, fromPrice });
  const controlTitle = `Night Trains ${cityA} to ${cityB} — Times, Stops & Tickets | Pingwi`;

  if (variant !== FACTS) return { title: controlTitle, description: intro, intro };

  const primary = pickPrimaryDirection(cityA, directions);
  const frequency = primary ? frequencyPhrase(primary.serviceDays) : "";
  // The primary train's own duration, not the pair's fastest: the description
  // names that train, and it is the figure RouteFactsGrid prints for it, so the
  // snippet and the page cannot quote different numbers for the same journey.
  const durationText = durationForDirection(primary);

  return {
    title: factsTitle({ cityA, cityB, durationText, frequency }),
    description: factsDescription({
      cityA,
      cityB,
      trainCount,
      operatorNames,
      fromPrice,
      primary,
      durationText,
      frequency,
    }),
    intro,
  };
}
