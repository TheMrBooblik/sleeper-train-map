/**
 * The plan URL grammar — the one place a shareable plan is written and read.
 *
 *   /plan                                          empty planner
 *   /plan/amsterdam                                "where could I go from here"
 *   /plan/amsterdam/2026-09-18                     …on a given night
 *   /plan/amsterdam-to-vienna                      a corridor
 *   /plan/amsterdam-to-vienna/2026-09-18           a corridor on a given night
 *   /plan/amsterdam-to-vienna/2026-11              …its cheapest nights in a month
 *   /plan/amsterdam-to-berlin-to-prague-to-vienna/2026-09-18
 *                                                  a multi-night trip
 *
 * The URL *is* the saved plan: no account, no cookie, nothing about the person
 * stored anywhere. That is only true if the path holds the whole plan, so
 * anything a reader needs to reproduce what the author saw lives here — the
 * cities, in order, and the first departure date — or the month to look for
 * the cheapest night in, or nothing for "any time". `?stay=` carries the optional
 * stopover nights, a refinement of a plan rather than its identity.
 *
 * Dependency-free and .mjs for the same reason as slugify.mjs: the build, the
 * client router and raw-node tests must all compute the same string, or a
 * shared link resolves to a different plan than the one that was shared.
 */

/** The separator between cities. Matches the /connections/{a}-to-{b} grammar. */
const CITY_SEPARATOR = "-to-";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Split a corridor segment into city slugs.
 *
 * Splitting on "-to-" is only safe while no city slug contains it; today none
 * of the 186 endpoint cities does, and verify-plan.mjs fails the build if one
 * ever appears. `knownSlugs` is the belt to that braces: when supplied, a piece
 * that is not a known city is re-joined with its neighbour, so a future
 * "x-to-y"-shaped city name degrades to a wrong-but-harmless split instead of
 * silently inventing two cities.
 *
 * @param {string} segment
 * @param {Set<string>} [knownSlugs]
 * @returns {string[]}
 */
export function splitCorridor(segment, knownSlugs) {
  const pieces = String(segment || "")
    .split(CITY_SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!knownSlugs || pieces.length < 2) return pieces;

  const out = [];
  for (const piece of pieces) {
    if (knownSlugs.has(piece) || out.length === 0) {
      out.push(piece);
      continue;
    }
    const merged = `${out[out.length - 1]}${CITY_SEPARATOR}${piece}`;
    if (knownSlugs.has(merged)) out[out.length - 1] = merged;
    else out.push(piece);
  }
  return out;
}

/**
 * Read a plan out of the path segments Next hands a catch-all route.
 *
 * @param {string[]|string|undefined} slug - router params.slug
 * @param {Set<string>} [knownSlugs] - city slugs the dataset actually has
 * @returns {{cities: string[], date: string|null, month: string|null, extra: string[]}}
 *   `month` only where no night is given: a night is the more specific ask.
 *   `extra` is any trailing segment that is neither a corridor nor a date; a
 *   caller uses it to decide between "render this plan" and "404".
 */
export function parsePlanPath(slug, knownSlugs) {
  const segments = (Array.isArray(slug) ? slug : slug ? [slug] : [])
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);

  let cities = [];
  let date = null;
  let month = null;
  const extra = [];

  for (const segment of segments) {
    if (DATE_RE.test(segment)) {
      if (date) extra.push(segment);
      else date = segment;
      continue;
    }
    if (isPlanMonth(segment)) {
      if (month) extra.push(segment);
      else month = segment;
      continue;
    }
    if (cities.length === 0) {
      cities = splitCorridor(segment, knownSlugs);
      continue;
    }
    extra.push(segment);
  }

  return { cities, date, month: date ? null : month, extra };
}

/**
 * Read a plan URL as the browser holds it — "/plan/a-to-b/2026-09-18?stay=1".
 *
 * Every /plan/* URL is served the one static /plan page through a rewrite (see
 * next.config.js), so Next hands the page no `slug` param: the plan is read
 * off the path itself, after mount.
 *
 * @param {string} asPath
 * @returns {{slug: string[], stay: string|null}}
 */
export function planPartsFromPath(asPath) {
  const raw = String(asPath || "");
  const [beforeHash] = raw.split("#");
  const queryAt = beforeHash.indexOf("?");
  const pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const search = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  const rest = pathname.replace(/^\/plan(?=\/|$)/, "");
  const slug = rest === pathname ? [] : rest.split("/").filter(Boolean).map(safeDecode);
  const stay = new URLSearchParams(search).get("stay");
  return { slug, stay };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Write a plan back to a path. The inverse of parsePlanPath for every plan the
 * planner can produce.
 *
 * @param {{cities?: string[], date?: string|null, month?: string|null}} plan
 *   a night wins over a month; neither is "any time"
 * @returns {string} an absolute site path, always starting "/plan"
 */
export function buildPlanPath({ cities = [], date = null, month = null } = {}) {
  const clean = cities.map((c) => String(c || "").trim().toLowerCase()).filter(Boolean);
  const parts = ["/plan"];
  if (clean.length) parts.push(clean.join(CITY_SEPARATOR));
  if (clean.length) {
    if (date && DATE_RE.test(date)) parts.push(date);
    else if (isPlanMonth(month)) parts.push(month);
  }
  return parts.join("/");
}

/**
 * The full href for a plan, including the stopover refinement.
 * @param {{cities?: string[], date?: string|null, month?: string|null, stays?: number[]}} plan
 * @returns {string}
 */
export function buildPlanHref(plan = {}) {
  const path = buildPlanPath(plan);
  const stays = encodeStays(plan.stays, plan.cities?.length ?? 0);
  return stays ? `${path}?stay=${stays}` : path;
}

/**
 * Extra nights spent in each intermediate city, as a comma list. One entry per
 * hop after the first, so "2,0" on a four-city plan means two extra nights in
 * the second city and none in the third.
 * @param {number[]|undefined} stays
 * @param {number} cityCount
 * @returns {string} "" when every stay is zero — the default is never encoded
 */
export function encodeStays(stays, cityCount) {
  const hops = Math.max(0, cityCount - 1);
  if (!Array.isArray(stays) || hops < 2) return "";
  const slice = stays.slice(0, hops - 1).map((n) => clampStay(n));
  return slice.some((n) => n > 0) ? slice.join(",") : "";
}

/** @param {string|string[]|undefined} value @returns {number[]} */
export function decodeStays(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((n) => clampStay(Number.parseInt(n, 10)))
    .filter((n) => Number.isFinite(n));
}

/** Stopovers are a UI affordance, not an itinerary planner: 0–30 nights. */
export function clampStay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(30, Math.max(0, Math.trunc(n)));
}

/** "2026-11" — a month to look for the cheapest night in. */
export function isPlanMonth(value) {
  if (!MONTH_RE.test(String(value || ""))) return false;
  const m = Number(String(value).slice(5, 7));
  return m >= 1 && m <= 12;
}

/** The month a night falls in: "2026-11-06" → "2026-11". */
export function monthOf(iso) {
  return isPlanDate(iso) ? iso.slice(0, 7) : "";
}

/** A month `n` months on: ("2026-11", 2) → "2027-01". */
export function addMonths(month, n) {
  if (!isPlanMonth(month)) return month;
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + Number(n || 0);
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Every night of a month, from `from` on when it falls inside it. */
export function nightsInMonth(month, from = "") {
  if (!isPlanMonth(month)) return [];
  const out = [];
  for (let night = `${month}-01`; monthOf(night) === month; night = addDays(night, 1)) {
    if (!from || night >= from) out.push(night);
  }
  return out;
}

/** @param {string} value @returns {boolean} */
export function isPlanDate(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const [y, m, d] = String(value).split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * Add whole days to an ISO date without going near a local timezone — a plan
 * date is a calendar date, and reading it as an instant is how "the night of
 * the 18th" becomes the 17th for half the world.
 * @param {string} iso @param {number} days @returns {string}
 */
export function addDays(iso, days) {
  if (!isPlanDate(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return probe.toISOString().slice(0, 10);
}

/**
 * Whole days from one ISO date to another (negative when `b` is earlier), read
 * as calendar dates for the same reason as addDays.
 * @param {string} a @param {string} b @returns {number}
 */
export function daysBetween(a, b) {
  if (!isPlanDate(a) || !isPlanDate(b)) return 0;
  const toDay = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return Math.round(toDay(b) - toDay(a));
}

/**
 * The departure date of each hop assuming every train arrives the next morning:
 * the first from the plan, each later one a day after the previous, plus any
 * stopover nights. resolvePlan dates hops from each train's real arrival day
 * instead (a two-night train pushes the next hop a day further); this is the
 * same rule for the common one-night case, kept for callers with no trains.
 * @param {string} startDate @param {number} hopCount @param {number[]} stays
 * @returns {string[]}
 */
export function hopDates(startDate, hopCount, stays = []) {
  const out = [];
  let cursor = startDate;
  for (let i = 0; i < hopCount; i++) {
    out.push(cursor);
    // A sleeper departs in the evening and arrives the next morning, so the
    // earliest a following sleeper can leave is that same next day: +1.
    cursor = addDays(cursor, 1 + clampStay(stays[i] ?? 0));
  }
  return out;
}
