/**
 * Station name → city name, the single source of truth for every SEO URL slug.
 *
 * A connection URL is /connections/{cityA}-to-{cityB}, so the city name IS the
 * URL. Getting it wrong is expensive: the slug is indexed, and changing it later
 * costs a redirect. Resolution order:
 *
 *   1. data/overrides/station-cities.json — exact station name → city. Carries the
 *      English exonyms ("Praha hl.n." → Prague, "Wien Hbf" → Vienna) and the
 *      station-qualifier strips the generic rules can't infer ("Zemun" → Belgrade,
 *      "Ny Moynihan Train Hall At Penn Station" → New York). Admin-editable via
 *      the same override plumbing as station-coordinates.json.
 *   2. A generic fallback for stations the table doesn't know yet (a nightly scrape
 *      can add endpoints between reviews) — strips parentheticals, bilingual
 *      "A / B" second halves and common station-type qualifiers.
 *
 * This module is deliberately dependency-free and .mjs so raw-node scripts
 * (scripts/build-seo-redirects.mjs) and the Next build resolve slugs identically.
 * Divergence between the two would silently produce redirects pointing at URLs
 * the build never emits.
 */

import STATION_CITIES from "../../../data/overrides/station-cities.json" with { type: "json" };

// Station-type qualifiers that follow a city name. Matched at end of string only,
// so "Central African …"-style names are never truncated mid-word.
const QUALIFIER =
  /\s+(centraal|centrale|central|hauptbahnhof|hbf|hb|bahnhof|station|terminal|termini|glowny|główny|glowna|główna|gł\.|gl\.|holovna|holovny|hl\.\s*n\.|hl\.st\.|nord|ville|c|s)$/i;

/**
 * Best-effort city name for a station the override table doesn't cover.
 * @param {string} name
 * @returns {string}
 */
function fallbackCity(name) {
  let out = String(name).trim();

  // "Qiqihar(齐齐哈尔)" → "Qiqihar";  "Frankfurt (Main) Flughafen" → "Frankfurt"
  const paren = out.indexOf("(");
  if (paren > 0) out = out.slice(0, paren).trim();

  // Bilingual labels: "Bolzano / Bozen" → "Bolzano". Keep the first name only —
  // it is the one English sources use for every case in the current dataset.
  const slash = out.indexOf("/");
  if (slash > 0) out = out.slice(0, slash).trim();

  // Strip repeatedly: "Kraków Gł." → "Kraków", "Praha hl.n." → "Praha".
  let prev;
  do {
    prev = out;
    out = out.replace(QUALIFIER, "").trim();
  } while (out !== prev && out);

  return out || String(name).trim();
}

/**
 * The city a station belongs to, for URL and heading purposes.
 * @param {string} stationName - raw station name as it appears in the payload
 * @returns {string}
 */
export function cityForStation(stationName) {
  if (!stationName) return "";
  const raw = String(stationName).trim();
  return STATION_CITIES[raw] || fallbackCity(raw);
}

/**
 * Cities the table already assigns to a station whose name begins with this
 * token. "Hamburg" -> "Hamburg" (from "Hamburg Harburg"), "Milano" -> "Milan"
 * (from "Milano Centrale"). Built once; the table is a build-time import.
 */
let _cityByLeadingToken;
function cityByLeadingToken() {
  if (!_cityByLeadingToken) {
    const byToken = new Map();
    for (const [station, city] of Object.entries(STATION_CITIES)) {
      const token = leadingToken(station);
      if (!token) continue;
      if (!byToken.has(token)) byToken.set(token, new Set());
      byToken.get(token).add(city);
    }
    _cityByLeadingToken = new Map();
    // Only an unambiguous token is a usable hint: if two stations sharing a first
    // word sit in different cities, the word does not name a city.
    for (const [token, cities] of byToken) {
      if (cities.size === 1) _cityByLeadingToken.set(token, [...cities][0]);
    }
  }
  return _cityByLeadingToken;
}

function leadingToken(name) {
  return String(name || "")
    .trim()
    .split(/[\s/,(]+/)[0]
    .toLowerCase();
}

/**
 * Endpoint station names with no explicit table entry — the review surface for
 * "a nightly scrape added a route and nobody named its city yet". Consumed by
 * tests/verify-seo-urls.mjs, which reports rather than fails so a new route can
 * never break CI on its own.
 *
 * Two shapes qualify, and the second one is why this exists in its present form.
 * The original rule only reported a name the fallback had changed, which made it
 * blind to the failure that actually costs a page: a station whose qualifier the
 * fallback does not recognise, so it is left alone and silently becomes its own
 * city. "Hamburg Altona" gave five Nightjet routes URLs under
 * /connections/hamburg-altona-to-*, and "Milano Certosa" exiled European
 * Sleeper's running Brussels-Milan train to its own page while the canonical
 * /connections/brussels-to-milan carried only the December preview. Neither was
 * ever reported, though the table already held "Hamburg Harburg" and "Milano
 * Centrale" one line away. So a name is also reported when the table assigns a
 * city to another station sharing its first word.
 *
 * A single-token name still cannot be caught — "Mitry-Claye" really is its own
 * commune, and only a human knows it stands in for Paris on ES 475.
 * @param {string[]} stationNames
 * @returns {string[]}
 */
export function stationsMissingCityOverride(stationNames) {
  const missing = new Set();
  const hints = cityByLeadingToken();
  for (const name of stationNames) {
    const raw = String(name || "").trim();
    if (!raw || STATION_CITIES[raw]) continue;
    // The fallback had to do real work — an untouched name ("Sofia") is already
    // its own city and needs no entry.
    if (fallbackCity(raw) !== raw) {
      missing.add(raw);
      continue;
    }
    // Or the fallback left it alone but a sibling station names its city.
    const hint = hints.get(leadingToken(raw));
    if (hint && hint !== raw) missing.add(raw);
  }
  return [...missing].sort();
}
