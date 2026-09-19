/**
 * Matching a typed query against the city list.
 *
 * Lives here rather than in CityCombobox.js because it is ranking logic with no
 * rendering in it, and a .js file carrying JSX cannot be loaded by a raw-node
 * test — so as long as it sat in the component, the rule that matters most
 * (a name match always beats suggestion weighting) had nothing asserting it.
 */

import { bySuggestionScore, suggestionScore } from "./prominence.mjs";

export const MAX_RESULTS = 8;

/** Lowercased and stripped of diacritics, so "Zürich" answers to "zurich". */
export function normalizeQuery(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Rank: a name that starts with the query beats one that merely contains it.
 *
 * Match quality always wins, and suggestion weighting only ever breaks a tie
 * WITHIN a match class — so typing "Lviv" returns Lviv first however far down
 * the unprompted list it sits. With no query there is nothing to match on, so
 * the list is simply what we would suggest.
 *
 * @param {object[]} cities
 * @param {string} query
 * @param {number} [limit]
 * @returns {object[]}
 */
export function rankCities(cities, query, limit = MAX_RESULTS) {
  const q = normalizeQuery(query).trim();
  if (!q) return [...(cities ?? [])].sort(bySuggestionScore).slice(0, limit);

  const scored = [];
  for (const city of cities ?? []) {
    const name = normalizeQuery(city.name);
    let score = null;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (normalizeQuery(city.slug).includes(q)) score = 3;
    if (score === null) continue;
    scored.push({ city, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || suggestionScore(b.city) - suggestionScore(a.city),
  );
  return scored.slice(0, limit).map((s) => s.city);
}
