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
 * Endpoint station names with no explicit table entry — the review surface for
 * "a nightly scrape added a route and nobody named its city yet". Consumed by
 * tests/verify-seo-urls.mjs, which reports rather than fails so a new route can
 * never break CI on its own.
 * @param {string[]} stationNames
 * @returns {string[]}
 */
export function stationsMissingCityOverride(stationNames) {
  const missing = new Set();
  for (const name of stationNames) {
    const raw = String(name || "").trim();
    if (!raw || STATION_CITIES[raw]) continue;
    // Only interesting when the fallback had to do real work — an untouched
    // name ("Sofia") is already its own city and needs no entry.
    if (fallbackCity(raw) !== raw) missing.add(raw);
  }
  return [...missing].sort();
}
