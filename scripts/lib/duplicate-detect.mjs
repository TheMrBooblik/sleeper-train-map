// scripts/lib/duplicate-detect.mjs
// Deterministic "is this new Back-on-Track route already on the map?" detector.
// Pure and dependency-light (only the shared Levenshtein + a calendar parser),
// with all lookups injected so it stays unit-testable and can run inside the
// nightly classifier (which must decide auto-show vs gate WITHOUT depending on
// the best-effort AI step).
//
// The classifier auto-shows a new BoT route unless this finds a plausible
// duplicate among the routes already on the map (trusted/official synthetic
// rows + previously-approved rows) — in which case the route is gated for a
// one-click admin decision. Official data therefore keeps priority: a BoT row
// that merely restates an official route never silently doubles it.
//
// "Balanced" rule (the product default): a candidate qualifies when the two
// routes share ENDPOINTS (origin+destination, direction-agnostic, matched by
// alias-resolved name OR coordinate proximity) AND either their operating days
// overlap OR they run under the same operator. Via-overlap and train-number
// similarity only sharpen the score; they are never required.

import { levenshtein } from "./text-similarity.mjs";
import { parseBotServiceString } from "../../src/pages/api/lib/calendar.mjs";

// Tuning knobs (kept here so the sensitivity is easy to find and adjust).
export const COORD_MATCH_KM = 25; // "same place" radius for endpoint matching
export const MIN_SCORE = 1; // endpoint match alone clears this; boosts add on top

const identity = (s) => s;

function norm(name, resolveName) {
  if (name == null) return "";
  const resolved = (resolveName ?? identity)(String(name));
  return String(resolved).toLowerCase().trim();
}

// Build a `coordsOf(name)` lookup from Back-on-Track stops + the manual
// coordinate overrides, alias-resolving on miss. Pure (callers read the files);
// shared by the classifier and the AI second-opinion task.
export function buildCoordsLookup({
  botStops = {},
  overrides = {},
  resolveName = identity,
} = {}) {
  const idx = new Map();
  const add = (name, lat, lon) => {
    if (!name || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return;
    const k = name.toString().toLowerCase().trim();
    if (!idx.has(k)) idx.set(k, { lat: Number(lat), lon: Number(lon) });
  };
  for (const s of Object.values(botStops ?? {})) add(s?.stop_name, s?.stop_lat, s?.stop_lon);
  for (const [name, c] of Object.entries(overrides ?? {})) add(name, c?.lat, c?.lon);
  return (name) => {
    if (!name) return null;
    const direct = idx.get(name.toString().toLowerCase().trim());
    if (direct) return direct;
    const resolved = resolveName(name.toString()).toLowerCase().trim();
    return idx.get(resolved) ?? null;
  };
}

function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Two station names refer to the same place when their alias-resolved names are
// equal, or (failing that) their coordinates are within COORD_MATCH_KM.
function sameStation(n1, n2, helpers) {
  const a = norm(n1, helpers.resolveName);
  const b = norm(n2, helpers.resolveName);
  if (!a || !b) return false;
  if (a === b) return true;
  const ca = helpers.coordsOf?.(n1);
  const cb = helpers.coordsOf?.(n2);
  if (ca && cb && haversineKm(ca, cb) <= (helpers.coordKm ?? COORD_MATCH_KM)) {
    return true;
  }
  return false;
}

// Direction-agnostic endpoint match: A→B equals A→B or B→A.
function endpointsMatch(a, b, helpers) {
  const aO = a.origin_trip_0;
  const aD = a.destination_trip_0;
  const bO = b.origin_trip_0;
  const bD = b.destination_trip_0;
  if (!aO || !aD || !bO || !bD) return false;
  const forward = sameStation(aO, bO, helpers) && sameStation(aD, bD, helpers);
  const reverse = sameStation(aO, bD, helpers) && sameStation(aD, bO, helpers);
  return forward || reverse;
}

function daysOf(route) {
  const set = new Set();
  for (const d of [0, 1]) {
    const cal = parseBotServiceString(route[`service_id_${d}`]);
    cal.daysOfWeek.forEach((day) => set.add(day));
  }
  return set;
}

// Lenient on purpose: if either side has no parseable day list we can't rule a
// duplicate out, so we treat it as overlapping (the endpoint match is the hard
// gate; this only separates two same-corridor services on disjoint days).
function daysOverlap(a, b) {
  const da = daysOf(a);
  const db = daysOf(b);
  if (da.size === 0 || db.size === 0) return true;
  for (const day of da) if (db.has(day)) return true;
  return false;
}

function operatorTokens(route) {
  return new Set(
    String(route?.agency_id ?? "")
      .toLowerCase()
      .split(/[/,&+]/)
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

function sameOperator(a, b) {
  const ta = operatorTokens(a);
  const tb = operatorTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function viaSet(route, helpers) {
  const out = new Set();
  for (const d of [0, 1]) {
    String(route[`via_${d}`] ?? "")
      .split(" - ")
      .map((s) => norm(s, helpers.resolveName))
      .filter(Boolean)
      .forEach((s) => out.add(s));
  }
  return out;
}

function viaJaccard(a, b, helpers) {
  const sa = viaSet(a, helpers);
  const sb = viaSet(b, helpers);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// "EN 442", "IC Notte 770", "452" → "442" / "770" / "452" (longest digit run).
export function normalizeTrainNumber(name) {
  const runs = String(name ?? "").match(/\d+/g);
  if (!runs) return "";
  return runs.sort((x, y) => y.length - x.length)[0];
}

function trainNumbersOf(route) {
  return [route?.trip_short_name_0, route?.trip_short_name_1]
    .map(normalizeTrainNumber)
    .filter(Boolean);
}

function trainNumbersSimilar(a, b) {
  const na = trainNumbersOf(a);
  const nb = trainNumbersOf(b);
  for (const x of na) {
    for (const y of nb) {
      if (x === y) return true;
      if (Math.abs(x.length - y.length) <= 1 && levenshtein(x, y, 1) <= 1) return true;
    }
  }
  return false;
}

function endpointLabel(route) {
  return `${route?.origin_trip_0 ?? "?"} ↔ ${route?.destination_trip_0 ?? "?"}`;
}

/**
 * Score one route pair. Returns { qualifies, score, reasons[] }.
 * `qualifies` follows the Balanced rule; `score` lets callers rank candidates
 * and, with a lower floor, surface softer matches (the AI second-opinion uses
 * this to re-check already-live routes).
 */
export function scoreRoutePair(route, candidate, helpers = {}) {
  const reasons = [];
  if (!endpointsMatch(route, candidate, helpers)) {
    return { qualifies: false, score: 0, reasons };
  }
  reasons.push(`same endpoints (${endpointLabel(candidate)})`);
  let score = 1;

  const days = daysOverlap(route, candidate);
  const operator = sameOperator(route, candidate);
  if (days) reasons.push("operating days overlap");
  if (operator) reasons.push(`same operator (${candidate.agency_id})`);

  const jac = viaJaccard(route, candidate, helpers);
  if (jac > 0) {
    score += jac;
    if (jac >= 0.5) reasons.push(`via stations overlap ${Math.round(jac * 100)}%`);
  }
  if (trainNumbersSimilar(route, candidate)) {
    score += 0.5;
    reasons.push("train numbers match");
  }
  if (operator) score += 0.25;

  // Balanced: endpoints + (days OR operator).
  const qualifies = days || operator;
  return { qualifies, score, reasons };
}

/**
 * Best duplicate among `candidates` ([key,row][]) for `route`, or null.
 *
 * @param {object} route        new BoT viewMap row being classified
 * @param {Array<[string,object]>} candidates  routes already on the map
 * @param {object} helpers      { resolveName?, coordsOf?, coordKm? }
 * @param {object} [opts]       { minScore?, requireQualify? }
 * @returns {{ key:string, score:number, reasons:string[] }|null}
 */
export function findDuplicateCandidate(route, candidates, helpers = {}, opts = {}) {
  const minScore = opts.minScore ?? MIN_SCORE;
  const requireQualify = opts.requireQualify ?? true;
  let best = null;
  for (const [key, candidate] of candidates ?? []) {
    if (!candidate || candidate === route) continue;
    if (key != null && route?.route_id != null && key === route.route_id) continue;
    const { qualifies, score, reasons } = scoreRoutePair(route, candidate, helpers);
    if (reasons.length === 0) continue; // no endpoint match at all
    if (requireQualify && !qualifies) continue;
    if (score < minScore) continue;
    if (!best || score > best.score) best = { key, score, reasons };
  }
  return best;
}
