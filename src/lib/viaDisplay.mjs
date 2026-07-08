// Display-only helpers for summarising long "via" strings in Train Details.
// Full via data stays in routes/trips for map dots, direction sorting, and
// the station accordion — this module picks at most 3 major/hub stops.

import alwaysShowStations from "../../data/overrides/always-show-stations.json" with { type: "json" };
import { parseViaList } from "./seo/format.js";
import { normalizeStationNameForLookup } from "../hooks/requests/useCities.js";

/** Main-station suffixes (European + Polish). */
const MAIN_STATION_SUFFIX =
  /\b(hbf|hauptbahnhof|centraal|central|hl\.n\.|główny|glowny|hb)\b/i;

/**
 * North-American / remote hubs not always on the map allowlist. Matched as a
 * whole word inside the normalised station name (case-insensitive).
 */
const MAJOR_CITY_TOKENS = [
  "Chicago",
  "Minneapolis",
  "Milwaukee",
  "Spokane",
  "Winnipeg",
  "Edmonton",
  "Jasper",
  "Saskatoon",
  "Calgary",
  "Regina",
  "Ottawa",
  "Montreal",
  "Halifax",
  "Denver",
  "Sacramento",
  "Portland",
  "Seattle",
  "Salt Lake",
  "Omaha",
  "Fargo",
  "Whitefish",
  "New Orleans",
  "Houston",
  "Dallas",
  "Atlanta",
  "Washington",
  "Baltimore",
  "Philadelphia",
  "Boston",
  "Toronto",
  "Vancouver",
];

/** Score tiers — higher wins when capping at max stops. */
const SCORE = {
  allowlist: 4,
  endpoint: 3,
  mainSuffix: 2,
  cityToken: 1,
};

function normalizeForMatch(value) {
  const normalized = normalizeStationNameForLookup(value);
  return typeof normalized === "string" ? normalized.trim().toLowerCase() : "";
}

function buildAlwaysShowRules() {
  return (alwaysShowStations || [])
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter(Boolean)
    .map((rawRule) => {
      const isPrefixRule = rawRule.endsWith("*");
      const ruleValue = isPrefixRule ? rawRule.slice(0, -1) : rawRule;
      return {
        isPrefixRule,
        value: normalizeForMatch(ruleValue),
      };
    })
    .filter((rule) => rule.value);
}

function matchesAlwaysShow(name, rules) {
  const normalized = normalizeForMatch(name);
  return rules.some((rule) =>
    rule.isPrefixRule
      ? normalized.startsWith(rule.value)
      : normalized === rule.value,
  );
}

function matchesMainSuffix(name) {
  return MAIN_STATION_SUFFIX.test(name);
}

/** Reject "Boston Bar"-style names that share a major-city prefix. */
const FALSE_CITY_SUFFIX = /^(bar|harbor|harbour|jct|junction|beach|creek|falls)\b/;

function matchesCityToken(name) {
  const normalized = normalizeForMatch(name);
  return MAJOR_CITY_TOKENS.some((token) => {
    const t = token.toLowerCase();
    if (normalized === t) return true;
    // Leading city: "Milwaukee Amtrak Station", "Denver Union Station"
    if (normalized.startsWith(`${t} `) || normalized.startsWith(`${t}-`)) {
      const rest = normalized.slice(t.length + 1);
      return !FALSE_CITY_SUFFIX.test(rest);
    }
    // Compound: "St. Paul-Minneapolis"
    if (
      normalized.endsWith(`-${t}`) ||
      normalized.endsWith(` ${t}`) ||
      normalized.includes(`-${t}-`) ||
      normalized.includes(` ${t} `)
    ) {
      return true;
    }
    return false;
  });
}

/**
 * One-time scan of viewMap rows for hub detection.
 * @param {Record<string, object> | null | undefined} viewMap
 * @returns {{ endpointNames: Set<string>, alwaysShowRules: object[] }}
 */
export function buildMajorViaContext(viewMap) {
  const endpointNames = new Set();
  Object.values(viewMap || {}).forEach((route) => {
    [
      route?.origin_trip_0,
      route?.destination_trip_0,
      route?.origin_trip_1,
      route?.destination_trip_1,
    ]
      .filter(Boolean)
      .forEach((name) => endpointNames.add(normalizeForMatch(name)));
  });

  return {
    endpointNames,
    alwaysShowRules: buildAlwaysShowRules(),
  };
}

/**
 * Score how "major" a via stop is (0 = not major).
 * @param {string} name
 * @param {{ endpointNames: Set<string>, alwaysShowRules: object[] }} ctx
 * @returns {number}
 */
export function majorViaScore(name, ctx) {
  if (!name) return 0;
  if (matchesAlwaysShow(name, ctx.alwaysShowRules)) return SCORE.allowlist;
  if (ctx.endpointNames.has(normalizeForMatch(name))) return SCORE.endpoint;
  if (matchesMainSuffix(name)) return SCORE.mainSuffix;
  if (matchesCityToken(name)) return SCORE.cityToken;
  return 0;
}

/**
 * @param {string} name
 * @param {{ endpointNames: Set<string>, alwaysShowRules: object[] }} ctx
 * @returns {boolean}
 */
export function isMajorViaStation(name, ctx) {
  return majorViaScore(name, ctx) > 0;
}

/**
 * Pick up to `max` major via stops in route order for the Train Details summary.
 * Returns null when no stops qualify (hide the via line).
 *
 * @param {string | null | undefined} viaString
 * @param {{ endpointNames: Set<string>, alwaysShowRules: object[] }} ctx
 * @param {{ max?: number }} [options]
 * @returns {string | null}
 */
export function selectMajorViaStations(viaString, ctx, { max = 3 } = {}) {
  const stops = parseViaList(viaString);
  if (stops.length === 0) return null;

  const majors = stops
    .map((name, index) => ({ name, index, score: majorViaScore(name, ctx) }))
    .filter((entry) => entry.score > 0);

  if (majors.length === 0) return null;

  const picked =
    majors.length <= max
      ? majors
      : [...majors]
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, max)
          .sort((a, b) => a.index - b.index);

  return picked.map((entry) => entry.name).join(" - ");
}
