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
import { formatLongDate } from "../nextDeparture.mjs";

/** Variant ids. FACTS is the new wording; CONTROL is the pinned former one. */
export const CONTROL = "control";
export const FACTS = "facts";

/**
 * Which pair pages render FACTS: a corridor on which any train is run by one of
 * these operators. Every other page renders CONTROL, byte for byte the wording
 * it carried before, so the rollout touches only the pages named here.
 *
 * Staged rather than site-wide (PR #88 shipped FACTS to all 240 pairs at once).
 * European Sleeper goes first because its four pages are the ones with the
 * least to lose — little Search Console traffic before this change — and the
 * most new to say, since this branch gives them a nightly fare. SNCF's nine
 * Intercités de Nuit corridors are the second stage (October 2026), on the
 * same footing: a published fare range and official stop lists and clocks
 * from SNCF's own feed. Widening the rollout is adding an operator id here;
 * reverting it is emptying the set.
 * `npm run seo-snippet-report` reads the same set, so what it calls the
 * treatment is what the build rendered.
 */
export const FACTS_AGENCIES = new Set(["ES", "SNCF"]);

/**
 * The variant a pair page renders, from the operators of its trains.
 * @param {string[]} agencyIds every operator id on the corridor, split
 * @returns {string} FACTS or CONTROL
 */
export function snippetVariantFor(agencyIds) {
  return (agencyIds || []).some((id) => FACTS_AGENCIES.has(String(id).trim())) ? FACTS : CONTROL;
}

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
 * The days a train's own label names, e.g. "IC Nuit 3754 (Sun)" → ["Sun"], or
 * null when it names none. Back-on-Track writes a weekday qualifier into the
 * label of a train that runs on fewer days than its route, and the row's
 * service string can still say "Daily" — SNCF's Albi portion read "IC Nuit
 * 3754 (Sun) … nightly" in the first SNCF preview of this snippet.
 */
export function labelDays(trainLabel) {
  const m = /\(([^)]*)\)\s*$/.exec(String(trainLabel || ""));
  if (!m) return null;
  const days = m[1].split(/[,/&]|\band\b/).map((d) => d.trim()).filter(Boolean);
  return days.length && days.every((d) => DAY_LABELS.includes(d)) ? days : null;
}

/**
 * The frequency phrase for a direction, withheld when its label names days
 * the service string contradicts: two sources disagreeing about when a train
 * runs is not something a snippet should pick a side in.
 */
export function directionFrequency(direction) {
  const phrase = frequencyPhrase(direction?.serviceDays);
  const named = labelDays(direction?.trainLabel);
  if (!named || !phrase) return phrase;
  const fromLabel = frequencyPhrase(named.join(", "));
  return fromLabel === phrase ? phrase : "";
}

/**
 * Whether a direction states a journey at all. Equal clocks at both ends are a
 * placeholder, not a timetable: Back-on-Track writes 00:00 → 00:00 for a train
 * that has never run (European Sleeper's Amsterdam–Milan ES 454/455,
 * "Postponed to 2027"), and read as clocks that is a 24-hour journey leaving
 * at midnight — which the first European Sleeper rollout of this snippet
 * printed.
 */
function hasJourneyClock(direction) {
  return Boolean(
    direction?.departure && direction?.arrival && direction.departure !== direction.arrival,
  );
}

/**
 * The day a direction's stated service window opens, "YYYY-MM-DD", or "" when
 * it states none ("2026: Daily"). Both calendar spellings lead with it:
 * "2026-12-14 – 2027-09-06: Mon, Wed, Fri" and "2026/10/02-12/11: Mon".
 */
function serviceStart(serviceDays) {
  const m = /^\s*(\d{4})[-/](\d{2})[-/](\d{2})/.exec(String(serviceDays || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * How far off a window's first night must be before the direction counts as
 * not running yet. A feed states its window from the next run, so a train
 * running now opens "tomorrow" (ES 474: 2026/10/02-12/11 on 1 October) — two
 * weeks clears any weekly train's gap between runs, and the December preview
 * rows open ten weeks out.
 */
const UPCOMING_AFTER_DAYS = 14;

/** True when `serviceDays` opens more than UPCOMING_AFTER_DAYS after `today`. */
function isUpcoming(serviceDays, today) {
  const start = serviceStart(serviceDays);
  if (!start || !today) return false;
  const days = (Date.parse(`${start}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days > UPCOMING_AFTER_DAYS;
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
  // Placeholder clocks: nothing about this journey is known, including a
  // stated duration, which is derived from the same placeholders (ES 454's
  // trip says 24h).
  if (direction.departure && direction.arrival && !hasJourneyClock(direction)) return "";

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
 * Prefers one already running on `today`, then one that states a journey
 * (a departure and a different arrival), then one running the way the title
 * reads — a page headed "Vienna to Zurich" whose sentence leaves Zurich reads
 * as a mistake — then the fullest stop list, then the train label so the
 * choice is stable between builds.
 *
 * "Already running" is load-bearing on European Sleeper's Brussels–Milan
 * page, which carries the December timetable as its own row: that row has one
 * stop more, and without it the snippet described a routing that starts on
 * 14 December, with its days.
 *
 * @param {string} cityA
 * @param {object[]} directions
 * @param {{today?: string}} [options] "YYYY-MM-DD"; without it nothing is upcoming
 * @returns {object|null}
 */
export function pickPrimaryDirection(cityA, directions, { today = "" } = {}) {
  const all = Array.isArray(directions) ? directions.filter(Boolean) : [];
  if (!all.length) return null;
  const running = all.filter((d) => !isUpcoming(d.serviceDays, today));
  const current = running.length ? running : all;
  const timed = current.filter(hasJourneyClock);
  const pool = timed.length ? timed : current;
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
    primary && hasJourneyClock(primary)
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
  // them, and on a single-train pair it is not emitted at all. Then the
  // berth types, then the tail — which carries the call to action — and a
  // price last, being the highest-intent fact on the page.
  //
  // Punctuality is deliberately not a clause, though SNCF's corridors carry
  // it: the AQST figure runs about five months behind ("in May 2026" in an
  // October snippet) and is as often 52% as 96%. It is on the page and in the
  // FAQ, where it can be read with its month and its 12-month figure.
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

const capitalize = (word) => (word ? `${word[0].toUpperCase()}${word.slice(1)}` : "");

/**
 * Title, description and intro for a corridor none of whose trains is running
 * now — a seasonal train out of season, on sale for next season.
 *
 * It takes precedence over both variants, because what the other two say is
 * wrong for it rather than merely plain: "1 night train connects Rijeka and
 * Warsaw. Compare timetables…" invites someone to book tonight a train whose
 * next run is in June, and that is what /connections/rijeka-to-warsaw said in
 * October 2026. The date the train runs again is the fact the searcher needs
 * before any other, so it goes in the title.
 *
 * @param {object} input
 * @param {{trainLabel?: string, operator?: string, stopCount?: number,
 *          run: {nextDeparture: string, nextDepartureText: string,
 *                previousText: string, season: string, seasonal: boolean}}} input.upcoming
 *   the corridor's earliest next run, already resolved (src/lib/nextDeparture.mjs)
 */
export function upcomingSnippet({ cityA, cityB, operatorNames = "", upcoming }) {
  const { run, trainLabel = "", operator = "", stopCount = 0 } = upcoming;
  const base = `${cityA} to ${cityB} Night Train`;
  const longDate = formatLongDate(run.nextDeparture);
  const seasonLabel = run.seasonal
    ? `${run.season ? `${capitalize(run.season)} Only` : "Seasonal"}, from ${run.nextDepartureText}`
    : `Next Run ${run.nextDepartureText}`;

  let title = `${base} — ${seasonLabel}`;
  if (title.length > TITLE_MAX) title = `${base} — from ${run.nextDepartureText}`;
  if (title.length > TITLE_MAX) title = base;
  title = title.length <= BRAND_BUDGET ? `${title}${BRAND}` : title;

  const train = [operator, trainLabel].filter(Boolean).join(" ");
  const lead = run.seasonal
    ? `${run.season ? `${capitalize(run.season)}-only` : "Seasonal"} night train: ` +
      `${train ? `${train} runs` : "it runs"} ${cityA}–${cityB} again from ${longDate}.`
    : `Not running now: ${train ? `${train} next runs` : "the next train runs"} ${cityA}–${cityB} on ${longDate}.`;
  const clauses = [
    { text: lead, drop: 0 },
    { text: run.previousText ? `Last season ${run.previousText}.` : "", drop: 2 },
    {
      text: stopCount >= 3 ? `Timetable, ${stopCount} stops and where to book.` : "Timetable and where to book.",
      drop: 1,
    },
  ].filter((c) => c.text);
  let kept = clauses;
  for (const rank of [1, 2]) {
    if (kept.map((c) => c.text).join(" ").length <= DESCRIPTION_MAX) break;
    kept = kept.filter((c) => c.drop !== rank);
  }

  // The page's header already shows the season and the dates in a card; the
  // paragraph under it only says who runs it and which timetable this is.
  const intro =
    (operatorNames ? `Run by ${operatorNames}. ` : "") +
    (run.seasonal ? "The timetable below is for next season." : "The timetable below is for its next run.");

  return { title, description: kept.map((c) => c.text).join(" "), intro };
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
 * @param {string} [input.today] "YYYY-MM-DD" — the build date, so a timetable
 *   that has not started yet is not the one described
 * @param {object|null} [input.upcoming] set only when NO train on the corridor
 *   runs now: the corridor's earliest next run (see upcomingSnippet), which
 *   then decides the wording under either variant
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
  today = "",
  upcoming = null,
} = {}) {
  if (upcoming?.run?.nextDeparture) return upcomingSnippet({ cityA, cityB, operatorNames, upcoming });
  const intro = controlDescription({ cityA, cityB, trainCount, operatorNames, fromPrice });
  const controlTitle = `Night Trains ${cityA} to ${cityB} — Times, Stops & Tickets | Pingwi`;

  if (variant !== FACTS) return { title: controlTitle, description: intro, intro };

  const primary = pickPrimaryDirection(cityA, directions, { today });
  const frequency = primary ? directionFrequency(primary) : "";
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
