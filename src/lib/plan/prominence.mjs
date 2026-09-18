/**
 * How prominently the planner SUGGESTS a city.
 *
 * A night-train dataset is not a market. Ranked by raw connectivity the
 * planner's "start from" chips opened with Lviv, Kyiv, Beijing, Shanghai and
 * Chengdu — six Ukrainian and five Chinese cities in the top 24, with Paris
 * 19th and Amsterdam, Brussels, Milan and Rome absent. Every one of those
 * routes is real; none of them is what someone planning a European sleeper trip
 * came here to be offered first.
 *
 * So a country carries a weight, declared with its reason in
 * data/overrides/city-prominence.json. The weight touches DISCOVERY ONLY —
 * which cities are suggested, and ties between equally-good destinations. It
 * never filters: every route stays searchable by name, stays on the map, keeps
 * its connection page, and is returned in full by any plan that asks for it.
 * That line is the whole design, and verify-plan asserts it from both sides.
 *
 * Pure and dependency-free: the index build (raw node) and the client both run
 * it, so a city cannot be ranked one way in the build and another in the picker.
 */

/**
 * @param {object} table - city-prominence.json
 * @param {"always"|"global"|"any"} [scope] - which weights to honour. "any"
 *   takes every entry (the global surfaces); "always" takes only those a
 *   region-filtered list should still apply — see the file's own readme.
 * @returns {(code: string) => number}
 */
export function prominenceLookup(table, scope = "any") {
  const weights = table?.weights ?? {};
  return (countryCode) => {
    const entry = weights[String(countryCode || "").toUpperCase()];
    const weight = typeof entry === "number" ? entry : entry?.weight;
    if (!Number.isFinite(weight) || weight < 0) return 1;
    if (scope === "any") return weight;
    const entryScope = typeof entry === "number" ? "always" : (entry?.scope ?? "always");
    return entryScope === scope ? weight : 1;
  };
}

/**
 * How high to put a city in the region-filtered "start from" chips.
 *
 * Deliberately NOT suggestionScore: that mixes weighted reach with terminus
 * reach, so the number it ranks by is not the number on the chip, and a reader
 * sees 36, 29, 24, 22, 20, 16, 10, 9, 12, 12, 5 and concludes the list is not
 * ranked at all. Here the sort key IS the count shown — night trains serving
 * the city — so the list reads as the top it claims to be. The only weight that
 * survives into a tab is one scoped "always", because a continent no longer
 * needs damping once it has a tab of its own.
 *
 * @param {object} city
 * @param {(code: string) => number} weightFor
 */
export function startCityScore(city, weightFor) {
  return (city?.routeCount ?? 0) * (weightFor ? weightFor(city?.country) : 1);
}

/** Whether we de-emphasise this city's country in discovery at all. */
export function isDeEmphasised(city, weightFor) {
  return weightFor ? weightFor(city?.country) < 1 : false;
}

/**
 * "Start from" order as one comparator, so the pre-rendered chips and the ones
 * the loaded index replaces them with cannot be sorted differently — that
 * difference is invisible in review and shows up as the list reshuffling under
 * the reader a second after the page paints.
 *
 * A de-emphasised city goes BEHIND every city we do suggest, rather than being
 * interleaved by its multiplied score. That is not a stronger de-emphasis, it
 * is the only one compatible with printing the count: Lviv has 43 night trains
 * and a damped score of 6.45, which sorts it between Milan's 7 and Amsterdam's
 * 6 — so the chips would read 8, 7, 7, 7, 43, 6, and a list whose numbers jump
 * like that reads as unsorted, which is the exact complaint this ranking exists
 * to answer. Pushed to the back, both blocks descend on their own count and the
 * shown window is the undamped one. Nothing is filtered: every city is still in
 * the list, still searchable by name, still on the map.
 *
 * @param {(code: string) => number} weightFor
 */
export function byStartCityScore(weightFor) {
  return (a, b) => {
    const demoted =
      Number(isDeEmphasised(a, weightFor)) - Number(isDeEmphasised(b, weightFor));
    if (demoted) return demoted;
    const diff = startCityScore(b, weightFor) - startCityScore(a, weightFor);
    if (diff) return diff;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), undefined, {
      sensitivity: "base",
    });
  };
}

/**
 * Connectivity weighted by where the trains actually go.
 *
 * Counting a city's legs flat made Przemyśl the 6th city we suggest, above
 * Prague — it has twenty terminating night trains and nineteen of them are
 * Ukraine's. It is not a Ukrainian city and must not be weighted as one, so
 * instead each leg counts for the prominence of the place it *reaches*: a
 * Polish border town serving a de-emphasised network scores like what it
 * serves, while Vienna and Paris, whose trains go everywhere, do not move.
 *
 * @param {object[]} legs
 * @param {object[]} cities - mutated: each gains `prominence`, `reach`, `terminusReach`
 * @param {(code: string) => number} weightFor
 */
export function scoreCities(legs, cities, weightFor) {
  const bySlug = new Map(cities.map((c) => [c.slug, c]));
  for (const city of cities) {
    city.prominence = weightFor(city.country);
    city.reach = 0;
    city.terminusReach = 0;
  }

  for (const leg of legs) {
    const stops = leg.stops ?? [];
    if (stops.length < 2) continue;
    const first = stops[0];
    const last = stops[stops.length - 1];
    for (const stop of stops) {
      const city = bySlug.get(stop.citySlug);
      if (!city) continue;
      // The far end of this ride from here; for a mid-route stop, the origin.
      const far = stop.citySlug === first.citySlug ? last : first;
      const weight = bySlug.get(far.citySlug)?.prominence ?? 1;
      city.reach += weight;
      if (stop.citySlug === first.citySlug || stop.citySlug === last.citySlug) {
        city.terminusReach += weight;
      }
    }
  }

  for (const city of cities) {
    city.reach = round(city.reach);
    city.terminusReach = round(city.terminusReach);
  }
  return cities;
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * How high to suggest a city. A terminus counts triple: trains ending there
 * make it a destination, while a stop they pass through at 3am does not.
 * @param {object} city
 * @returns {number}
 */
export function suggestionScore(city) {
  if (!city) return 0;
  const terminus = city.terminusReach ?? city.terminusCount ?? 0;
  const reach = city.reach ?? city.legCount ?? 0;
  return (terminus * 3 + reach) * (city.prominence ?? 1);
}

/** Suggestion order: score first, then name so the list is stable. */
export function bySuggestionScore(a, b) {
  const diff = suggestionScore(b) - suggestionScore(a);
  if (diff) return diff;
  return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), undefined, {
    sensitivity: "base",
  });
}
