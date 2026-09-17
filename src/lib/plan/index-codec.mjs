/**
 * Wire format for plan-index.json.
 *
 * Every stop repeats a station name, a city name and a city slug, and the graph
 * has 6 861 of them across 541 legs — so written out in full the artifact is
 * 881 KB of one-line JSON, which is both a needless download and a diff no
 * reviewer can read when the nightly job commits it. Interning the strings once
 * and referencing them by index cuts that to a fraction, and costs one expand
 * on read.
 *
 * `hydratePlanIndex` is idempotent, exactly like hydratePkpBundle(): an index
 * that is already expanded (a test fixture, an older file) is returned
 * untouched, so every reader can call it without knowing which shape it got.
 */

/** @param {object} index - the expanded shape buildLegs() produces */
export function packPlanIndex(index) {
  const names = [];
  const nameIds = new Map();
  const intern = (value) => {
    const key = String(value ?? "");
    let id = nameIds.get(key);
    if (id === undefined) {
      id = names.length;
      names.push(key);
      nameIds.set(key, id);
    }
    return id;
  };

  const citySlugIds = new Map();
  const cities = index.cities.map((city, i) => {
    citySlugIds.set(city.slug, i);
    return [
      city.slug, city.name, city.country || "", city.legCount || 0,
      city.terminusCount || 0, city.prominence ?? 1,
      city.reach ?? 0, city.terminusReach ?? 0,
    ];
  });

  // A stop's times are usually empty, so they ride as a trailing pair that is
  // simply absent when there is nothing to say.
  // 452 legs share 21 pricing records. Repeating them costs 40 KB for nothing.
  const pricings = [];
  const pricingIds = new Map();
  const internPricing = (pricing) => {
    if (!pricing) return -1;
    const key = JSON.stringify(pricing);
    let id = pricingIds.get(key);
    if (id === undefined) {
      id = pricings.length;
      pricings.push(pricing);
      pricingIds.set(key, id);
    }
    return id;
  };

  const legs = index.legs.map(({ pricing, durationSuspect, ...leg }) => ({
    ...leg,
    p: internPricing(pricing),
    ...(durationSuspect ? { ds: 1 } : {}),
    stops: leg.stops.map((stop) => {
      const base = [intern(stop.station), citySlugIds.get(stop.citySlug) ?? -1];
      if (stop.arrival || stop.departure) base.push(stop.arrival || "", stop.departure || "");
      return base;
    }),
  }));

  return { ...index, packed: true, names, pricings, cities, legs };
}

/** @param {object} index @returns {object} the expanded shape */
export function hydratePlanIndex(index) {
  if (!index || !index.packed) return index;

  const names = index.names ?? [];
  const cities = index.cities.map(
    ([slug, name, country, legCount, terminusCount, prominence, reach, terminusReach]) => ({
      slug,
      name,
      country,
      legCount,
      terminusCount: terminusCount || 0,
      prominence: prominence ?? 1,
      reach: reach ?? 0,
      terminusReach: terminusReach ?? 0,
    }),
  );

  const pricings = index.pricings ?? [];
  const legs = index.legs.map(({ p, ds, ...leg }) => ({
    ...leg,
    pricing: pricings[p] ?? null,
    durationSuspect: Boolean(ds),
    stops: leg.stops.map(([nameId, cityId, arrival, departure]) => {
      const city = cities[cityId] ?? { slug: "", name: "" };
      return {
        station: names[nameId] ?? "",
        city: city.name,
        citySlug: city.slug,
        arrival: arrival || "",
        departure: departure || "",
      };
    }),
  }));

  const { packed, names: _names, pricings: _pricings, ...rest } = index;
  return { ...rest, cities, legs };
}
