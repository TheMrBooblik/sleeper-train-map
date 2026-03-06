/**
 * Station name normalization and matching for map display and filtering.
 * Used for grouping city markers and matching station names across data sources.
 */

/**
 * Normalize station name for display (e.g. group "Paris Gare de Lyon" → "Paris").
 * Used for marker labels and filter display.
 * @param {string} stationName - Raw station name
 * @returns {string} Normalized display name
 */
export function normalizeStationNameForDisplay(stationName) {
  if (!stationName) return stationName;

  // Important exception: never group "Wiener Neustadt" into Vienna.
  // This keeps Wiener Neustadt as its own city marker even if the name also contains "Wien".
  if (stationName.includes("Wiener Neustadt")) {
    return "Wiener Neustadt";
  }

  if (stationName.includes("Paris")) return "Paris";
  if (
    stationName.includes("Bruxelles") ||
    stationName.includes("Brussels")
  ) {
    return "Brussels";
  }
  if (
    stationName.includes("Antwerpen") ||
    stationName.includes("Antwerp")
  ) {
    return "Antwerpen";
  }
  if (
    stationName.includes("Liège") ||
    stationName.includes("Liege") ||
    stationName.includes("Luik")
  ) {
    return "Liège";
  }
  // Treat only true Vienna stations as "Vienna" – do not include "Wiener Neustadt" or other "Wiener ..." names.
  if (/\bWien\b/.test(stationName) || stationName.includes("Vienna")) {
    return "Vienna";
  }
  if (
    stationName.includes("Milano") ||
    stationName.includes("Milan")
  ) {
    return "Milan";
  }
  if (
    stationName.includes("Torino") ||
    stationName.includes("Turin")
  ) {
    return "Torino";
  }
  if (
    (stationName.startsWith("Roma") ||
      stationName.startsWith("Rome") ||
      stationName.includes(" Roma ") ||
      stationName.includes(" Rome ")) &&
    !stationName.startsWith("Roman")
  ) {
    return "Rome";
  }
  if (stationName.includes("Berlin")) return "Berlin";
  if (
    stationName.includes("München") ||
    stationName.includes("Munich")
  ) {
    return "Munich";
  }
  if (stationName.includes("Hamburg")) return "Hamburg";
  if (
    stationName.includes("Köln") ||
    stationName.includes("Cologne")
  ) {
    return "Cologne";
  }
  if (stationName.includes("Frankfurt")) return "Frankfurt";
  if (stationName.includes("Amsterdam")) return "Amsterdam";
  if (
    stationName.includes("Zürich") ||
    stationName.includes("Zurich")
  ) {
    return "Zurich";
  }
  if (stationName.includes("Barcelona")) return "Barcelona";
  if (stationName.includes("Madrid")) return "Madrid";
  if (
    stationName.includes("Lisboa") ||
    stationName.includes("Lisbon")
  ) {
    return "Lisbon";
  }
  if (stationName.includes("Stockholm")) return "Stockholm";
  if (stationName.includes("Oslo")) return "Oslo";
  if (
    stationName.includes("København") ||
    stationName.includes("Copenhagen")
  ) {
    return "Copenhagen";
  }
  if (
    stationName.includes("Helsinki") ||
    stationName.includes("Helsingfors")
  ) {
    return "Helsinki";
  }
  if (
    stationName.includes("Warszawa") ||
    stationName.includes("Warsaw")
  ) {
    return "Warsaw";
  }
  if (
    stationName.includes("Kraków") ||
    stationName.includes("Krakow")
  ) {
    return "Krakow";
  }
  if (stationName.includes("Budapest")) return "Budapest";
  if (
    stationName.includes("Praha") ||
    stationName.includes("Prague")
  ) {
    return "Prague";
  }
  if (
    stationName.includes("București") ||
    stationName.includes("Bucharest")
  ) {
    return "Bucharest";
  }
  if (stationName.includes("Sofia")) return "Sofia";
  if (stationName.includes("Zagreb")) return "Zagreb";
  if (stationName.includes("Ljubljana")) return "Ljubljana";
  if (stationName.includes("Bratislava")) return "Bratislava";
  if (stationName.includes("Vilnius")) return "Vilnius";
  if (stationName.includes("Riga")) return "Riga";
  if (stationName.includes("Tallinn")) return "Tallinn";
  if (stationName.includes("Kyiv") || stationName.includes("Kiev")) {
    return "Kyiv";
  }
  if (stationName.includes("Minsk")) return "Minsk";
  if (stationName.includes("Ankara")) return "Ankara";
  if (stationName.includes("London")) return "London";
  if (
    stationName.includes("İstanbul") ||
    stationName.includes("Istanbul")
  ) {
    return "Istanbul";
  }
  if (stationName.includes("İzmir") || stationName.includes("Izmir")) {
    return "Izmir";
  }

  return stationName;
}

/**
 * Heuristic matcher for station names (handles Centraal, Hbf, brackets, diacritics).
 * Uses normalizeForLookup for both sides before comparing.
 * @param {string} a - First station name
 * @param {string} b - Second station name
 * @param {function(string): string} normalizeForLookup - From useCities (normalizeStationNameForLookup)
 * @returns {boolean}
 */
export function matchStationNames(a, b, normalizeForLookup) {
  if (!a || !b) return false;
  const simplify = (s) => {
    const n = (normalizeForLookup(String(s)) || "")
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/\b(centraal|central|bahnhof|station|hbf|hb)\b/gi, "")
      .replace(/[^a-zà-ÿ\s-]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    return n;
  };
  const A = simplify(a);
  const B = simplify(b);
  if (!A || !B) return false;
  if (A === B) return true;
  // For single-word station names (e.g. "Hove", "Eindhoven") require exact match only.
  // This prevents accidental matches where one short name is a substring of another.
  const wordsA = A.split(" ");
  const wordsB = B.split(" ");
  if (wordsA.length === 1 && wordsB.length === 1) {
    return false;
  }
  // For multi-word names (e.g. "Bruxelles Midi", "Paris Gare de Lyon"),
  // still allow "substring" matching, but ONLY when the shorter string appears
  // as a full word inside the longer one. This prevents false matches like
  // "Wien" matching "Wiener Neustadt".
  const containsAsWord = (text, sub) => {
    if (!text || !sub) return false;
    const pattern = new RegExp(`(^| )${sub}( |$)`);
    return pattern.test(text);
  };

  return containsAsWord(A, B) || containsAsWord(B, A);
}
