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

/** @param {object} table - city-prominence.json @returns {(code: string) => number} */
export function prominenceLookup(table) {
  const weights = table?.weights ?? {};
  return (countryCode) => {
    const entry = weights[String(countryCode || "").toUpperCase()];
    const weight = typeof entry === "number" ? entry : entry?.weight;
    return Number.isFinite(weight) && weight >= 0 ? weight : 1;
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
