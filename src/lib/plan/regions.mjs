/**
 * Which part of the world a city is in.
 *
 * The dataset is three products in one table: European sleepers, China
 * Railway's long-distance network, and Amtrak/VIA. Ranked together the
 * "start from" list was a tug of war — Beijing has more night trains than
 * Vienna and neither belongs above the other, because nobody planning one is
 * shopping for the other. A region toggle answers that structurally, which is
 * better than a weight: a weight makes Chengdu a quiet European city, while a
 * tab makes it a loud Asian one.
 *
 * Dependency-free and .mjs so the raw-node index build and the client both use
 * one table.
 */

export const REGIONS = [
  { id: "europe", label: "Europe" },
  { id: "asia", label: "Asia" },
  { id: "north-america", label: "North America" },
];

export const DEFAULT_REGION = "europe";

const BY_COUNTRY = {
  europe: [
    "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CZ", "DE", "DK", "EE", "ES",
    "FI", "FR", "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LT", "LU", "LV",
    "MD", "ME", "MK", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK",
    "UA", "XK",
    // Turkey sits in both, and the night trains we carry are the Balkan ones
    // out of İstanbul — a European corridor. Ankara–Kars is the exception the
    // label swallows.
    "TR",
  ],
  asia: [
    // The Caucasus: geographically arguable, but these are not trains anyone
    // reaches from a European sleeper network.
    "AM", "AZ", "GE",
    "CN", "IN", "JP", "KG", "KZ", "LA", "MM", "MN", "MY", "NP", "PK", "TH",
    "TJ", "TM", "UZ", "VN", "KR",
  ],
  "north-america": ["CA", "MX", "US"],
};

const COUNTRY_TO_REGION = new Map();
for (const [region, codes] of Object.entries(BY_COUNTRY)) {
  for (const code of codes) COUNTRY_TO_REGION.set(code, region);
}

/**
 * Eight hub cities resolve to no country: their station name is absent from
 * Back-on-Track's stop table under the spelling the routes use, so neither the
 * raw index nor the operator fallback can place them. Every one is European and
 * unambiguous, and Feldkirch is the 7th-busiest hub in Europe — dropping them
 * from every tab would be the worst of the options.
 */
export const CITY_COUNTRY_OVERRIDES = {
  bregenz: "AT",
  feldkirch: "AT",
  "fort-william": "GB",
  helsinki: "FI",
  inverness: "GB",
  "latour-de-carol": "FR",
  "reggio-calabria": "IT",
  turku: "FI",
};

/** @param {string} countryCode @returns {string} region id, or "" when unknown */
export function regionForCountry(countryCode) {
  return COUNTRY_TO_REGION.get(String(countryCode || "").toUpperCase()) || "";
}

/**
 * The region a city belongs to. A city we cannot place is in no region rather
 * than quietly in the default one — a wrong tab is worse than an absent chip,
 * and `verify-plan` counts how many are unplaced so the number cannot drift.
 * @param {{country?: string, slug?: string}} city
 */
export function regionForCity(city) {
  const code = city?.country || CITY_COUNTRY_OVERRIDES[city?.slug] || "";
  return regionForCountry(code);
}

/** @param {object[]} cities @returns {Map<string, object[]>} region id → cities */
export function groupByRegion(cities) {
  const grouped = new Map(REGIONS.map((r) => [r.id, []]));
  for (const city of cities ?? []) {
    const region = regionForCity(city);
    if (grouped.has(region)) grouped.get(region).push(city);
  }
  return grouped;
}

/**
 * How many "start from" chips a region shows.
 *
 * 24 cut Europe one slot above Amsterdam, and took Brussels, London, Stockholm
 * and Sofia with it — the cities a reader scans for first, absent from a list
 * headed "the most night trains" while Bohumín and Gdynia were on it. 32 ends
 * Europe at six trains, which is still a hub, and stops short of the long tail
 * of 4–5-train towns. It lives here, as one constant, because the server
 * pre-renders these chips and the client re-renders them from the loaded index:
 * two literals is two lists, and the difference shows up as the list changing
 * length a second after the page paints.
 */
export const START_CITY_LIMIT = 32;

/**
 * The "start from" chips, per region, already ranked and cut.
 *
 * Shared by the build-time reader and the page so the chips the server renders
 * and the ones the loaded index replaces them with are the same list in the
 * same order.
 *
 * @param {object[]} cities
 * @param {{limit?: number, compare?: (a: object, b: object) => number}} [options]
 * @returns {Map<string, object[]>} region id → cities
 */
export function topStartCitiesByRegion(cities, { limit = START_CITY_LIMIT, compare } = {}) {
  const startable = (cities ?? []).filter((c) => (c?.terminusCount ?? 0) > 0);
  const grouped = groupByRegion(startable);
  const out = new Map();
  for (const { id } of REGIONS) {
    const list = grouped.get(id) ?? [];
    out.set(id, (compare ? list.slice().sort(compare) : list).slice(0, limit));
  }
  return out;
}
