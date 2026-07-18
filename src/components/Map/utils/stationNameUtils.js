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
  if (stationName.includes("Bruxelles") || stationName.includes("Brussels")) {
    return "Brussels";
  }
  if (stationName.includes("Antwerpen") || stationName.includes("Antwerp")) {
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
  // "Roma Areeiro" is a Lisbon neighbourhood station, not Rome, Italy.
  if (stationName === "Roma Areeiro") return "Lisbon";
  if (
    (stationName.startsWith("Roma ") ||
      stationName.startsWith("Rome ") ||
      stationName.startsWith("Rom ") ||
      stationName.includes(" Roma ") ||
      stationName.includes(" Rome ")) &&
    !stationName.startsWith("Roman")
  ) {
    return "Rome";
  }
  if (stationName.includes("Venezia") || stationName.includes("Venice") || stationName.startsWith("Venedig")) return "Venice";
  if (stationName.includes("Firenze") || stationName.includes("Florence") || stationName.startsWith("Florenz")) return "Florence";
  if (stationName.includes("Napoli")  || stationName.includes("Naples")  || stationName.startsWith("Neapel"))  return "Naples";
  if (stationName.includes("Genova")  || stationName.includes("Genoa")   || stationName.startsWith("Genua"))   return "Genoa";
  if (stationName.includes("Trieste") || stationName.startsWith("Triest ")) return "Trieste";
  if (stationName.includes("Bologna")) return "Bologna";
  if (stationName.includes("Verona"))  return "Verona";
  if (stationName.includes("Torino")  || stationName.includes("Turin"))  return "Torino";
  if (stationName.includes("Mailand") || stationName.includes("Milano") || stationName.includes("Milan")) return "Milan";
  if (stationName.includes("Berlin")) return "Berlin";
  if (stationName.includes("München") || stationName.includes("Munich")) {
    return "Munich";
  }
  if (stationName.includes("Nürnberg") || stationName.includes("Nuremberg")) return "Nuremberg";
  if (stationName.includes("Hamburg")) return "Hamburg";
  if (stationName.includes("Köln") || stationName.includes("Cologne")) {
    return "Cologne";
  }
  if (stationName.includes("Frankfurt")) return "Frankfurt";
  if (stationName.includes("Amsterdam")) return "Amsterdam";
  if (stationName.includes("Zürich") || stationName.includes("Zurich")) {
    return "Zurich";
  }
  if (stationName.includes("Genève") || stationName.includes("Genf") || stationName.includes("Geneva")) return "Geneva";
  if (stationName.includes("Barcelona")) return "Barcelona";
  if (stationName.includes("Madrid")) return "Madrid";
  if (stationName.includes("Lisboa") || stationName.includes("Lisbon") || stationName.includes("Lissabon")) {
    return "Lisbon";
  }
  if (stationName.includes("Stockholm")) return "Stockholm";
  if (stationName.includes("Oslo")) return "Oslo";
  if (stationName.includes("København") || stationName.includes("Copenhagen") || stationName.includes("Kopenhagen")) {
    return "Copenhagen";
  }
  if (stationName.includes("Helsinki") || stationName.includes("Helsingfors")) {
    return "Helsinki";
  }
  if (stationName.includes("Warszawa") || stationName.includes("Warsaw") || stationName.includes("Warschau")) {
    return "Warsaw";
  }
  if (stationName.includes("Kraków") || stationName.includes("Krakow") || stationName.includes("Krakau")) {
    return "Krakow";
  }
  if (stationName.includes("Budapest")) return "Budapest";
  if (
    stationName.includes("Praha") ||
    stationName.includes("Prag") ||
    stationName.includes("Prague")
  ) {
    return "Prague";
  }
  if (stationName.includes("București") || stationName.includes("Bucharest") || stationName.includes("Bukarest")) {
    return "Bucharest";
  }
  if (stationName.includes("Belgrad") || stationName.includes("Beograd") || stationName.includes("Belgrade")) return "Belgrade";
  if (stationName.includes("Brüssel")) return "Brussels";
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
  if (stationName.includes("İstanbul") || stationName.includes("Istanbul")) {
    return "Istanbul";
  }
  if (stationName.includes("İzmir") || stationName.includes("Izmir")) {
    return "Izmir";
  }
  // "Kattowitz" is the German name for Katowice; group it like other German names (Brünn, Warschau).
  if (stationName.includes("Katowice") || stationName.includes("Kattowitz")) {
    return "Katowice";
  }
  if (stationName.startsWith("Sosnowiec")) return "Sosnowiec";
  // "Brünn" is the German name for Brno; group them so NJ and BoT routes merge.
  if (stationName.startsWith("Brno") || stationName.startsWith("Brünn")) return "Brno";
  // Czech/Slovak cities: group variants like "Ostrava hl.n." and "Ostrava Svinov" → "Ostrava".
  if (stationName.startsWith("Ostrava"))   return "Ostrava";
  if (stationName.startsWith("Pardubice")) return "Pardubice";
  if (stationName.startsWith("Olomouc"))   return "Olomouc";
  if (stationName.includes("Košice"))      return "Košice";
  if (stationName.includes("Žilina"))      return "Žilina";

  // China Railway — group terminus variants (West/South/Hongqiao/bei/dong/…)
  // the same way European Hbfs collapse to one city marker.
  if (stationName.includes("Beijing")) return "Beijing";
  if (stationName.includes("Shanghai")) return "Shanghai";
  if (stationName.includes("Guangzhou")) return "Guangzhou";
  if (stationName.includes("Chengdu")) return "Chengdu";
  if (stationName.includes("Chongqing")) return "Chongqing";
  // Xiandong = 西安东; avoid bare "Xian" (matches Xiangyang, Xianyang, …).
  if (
    stationName.includes("Xi'an") ||
    stationName.includes("Xi’an") ||
    /^Xiandong([\s(]|$)/i.test(stationName) ||
    /^Xianxi([\s(]|$)/i.test(stationName) ||
    /^Xianbei([\s(]|$)/i.test(stationName) ||
    /^Xiannan([\s(]|$)/i.test(stationName)
  ) {
    return "Xi'an";
  }
  if (stationName.includes("Harbin") || stationName.includes("Haerbin")) {
    return "Harbin";
  }
  if (
    stationName.includes("Wuhan") ||
    stationName.includes("Hankou") ||
    stationName.includes("Wuchang")
  ) {
    return "Wuhan";
  }
  if (stationName.includes("Zhengzhou")) return "Zhengzhou";
  if (stationName.includes("Hangzhou")) return "Hangzhou";
  if (stationName.includes("Shenzhen")) return "Shenzhen";
  if (stationName.includes("Nanning")) return "Nanning";
  if (stationName.includes("Guiyang")) return "Guiyang";
  if (stationName.includes("Taiyuan")) return "Taiyuan";
  if (stationName.includes("Lanzhou")) return "Lanzhou";
  if (stationName.includes("Hohhot")) return "Hohhot";
  if (stationName.includes("Baotou")) return "Baotou";
  if (stationName.includes("Tianjin")) return "Tianjin";
  if (stationName.includes("Nanjing")) return "Nanjing";
  if (stationName.includes("Kunming")) return "Kunming";
  if (stationName.includes("Qingdao")) return "Qingdao";
  if (stationName.includes("Shenyang")) return "Shenyang";
  if (stationName.includes("Changsha")) return "Changsha";
  if (stationName.includes("Nanchang")) return "Nanchang";
  if (stationName.includes("Urumqi") || stationName.includes("Wulumuqi")) {
    return "Urumqi";
  }

  // Strip common station-type suffixes so "City" and "City Centraal" / "City Hbf" group together.
  // "hl.n." = Czech "hlavní nádraží" (main station), equivalent to German "Hbf".
  const stripped = stationName.replace(/\s+(centraal|hbf|hauptbahnhof|central|hb|hl\.n\.)$/i, "").trim();
  if (stripped && stripped !== stationName) return stripped;

  return stationName;
}

/**
 * Abbreviate verbose station-type suffixes for display.
 * Add a new .replace() here when a language uses a long-form suffix that should be shortened.
 * @param {string} name - Station name as stored in data
 * @returns {string} Display-ready station name
 */
export function abbreviateStationName(name) {
  if (!name) return name;
  return name
    .replace(/\s+hlavní\s+nádraží/gi, " hl.n.")  // Czech: "Pardubice hlavní nádraží" → "Pardubice hl.n."
    .replace(/\s+hlavni\s+nadrazi/gi, " hl.n.");  // ASCII variant
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
