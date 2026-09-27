/**
 * A route's fares, per direction and per berth class.
 *
 * A row's `pricing` is one figure — the cheaper of its two directions — which
 * is right for a facts tile or a "from ¥X" badge on a card listing many
 * routes. It is the wrong figure for a card describing ONE train: Z 21 and
 * Z 22 are priced separately, and a sleeper sells several berth classes a
 * traveller chooses between. So an official source that prices its trains
 * (see stampOfficialFares in build-initial-data.mjs) also leaves the row
 * `fare_0` / `fare_1`: { fromPrice, currency, seatClass, classes, checkedAt }.
 *
 * Dependency-free `.mjs` so the map panel, the connection pages, the plan
 * index build and the raw-node tests all read it the same way.
 */

export const CURRENCY_SYMBOLS = {
  EUR: "€",
  GBP: "£",
  CHF: "CHF ",
  SEK: "kr ",
  CZK: "Kč ",
  PLN: "zł ",
  HUF: "Ft ",
  RON: "lei ",
  BGN: "лв ",
  UAH: "₴",
  TRY: "₺",
  CNY: "¥",
  GEL: "₾",
  AZN: "₼",
  AMD: "֏",
};

/** "¥335.5" — the amount as the operator quotes it, with the currency's symbol. */
export function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return "";
  const symbol = CURRENCY_SYMBOLS[currency] || (currency ? `${currency} ` : "");
  return `${symbol}${amount}`;
}

/** Traveller-facing names for the berth classes a fare may carry. */
export const FARE_CLASS_LABELS = {
  hardSleeper: "Hard sleeper",
  softSleeper: "Soft sleeper",
  deluxeSoftSleeper: "Deluxe soft sleeper",
  emuSleeper: "High-speed sleeper",
  emuFirstSleeper: "High-speed sleeper, 1st class",
  emuSecondSleeper: "High-speed sleeper, 2nd class",
  // Trenitalia Intercity Notte (lefrecce.it). Deliberately no "seat": this
  // map shows sleeping places only, and a class without a label is skipped.
  couchette: "Couchette",
  sleeperCabin: "Sleeper cabin",
};

export function fareClassLabel(key) {
  return (key && FARE_CLASS_LABELS[key]) || "";
}

/**
 * The fare one direction of a row carries, or null.
 * @param {object} row viewMap row
 * @param {0|1|"0"|"1"} dir
 */
export function directionFare(row, dir) {
  const fare = row?.[`fare_${dir}`];
  if (!fare || !Number.isFinite(fare.fromPrice) || fare.fromPrice <= 0 || !fare.currency) return null;
  return fare;
}

/**
 * The pricing record for one direction: the row's own record with that
 * direction's figure in place of the cheaper-of-both. Falls back to `base`
 * unchanged when the direction carries no fare of its own.
 */
export function pricingForDirection(row, dir, base = row?.pricing ?? null) {
  const fare = directionFare(row, dir);
  if (!fare) return base;
  return {
    ...(base || {}),
    currency: fare.currency,
    fromPrice: fare.fromPrice,
    source: fare.source ?? base?.source ?? null,
    checkedAt: fare.checkedAt ?? base?.checkedAt ?? null,
    seatClass: fare.seatClass ?? null,
  };
}

/**
 * A fare's berth classes, cheapest first, ready to print:
 * [{ key: "hardSleeper", label: "Hard sleeper", amount: 335.5, price: "¥335.5" }, …]
 * Classes with no known label are skipped rather than printed as a code.
 */
export function fareClassRows(fare) {
  if (!fare?.classes || typeof fare.classes !== "object") return [];
  return Object.entries(fare.classes)
    .filter(([key, amount]) => FARE_CLASS_LABELS[key] && Number.isFinite(amount) && amount > 0)
    .sort((a, b) => a[1] - b[1])
    .map(([key, amount]) => ({
      key,
      label: FARE_CLASS_LABELS[key],
      amount,
      price: formatMoney(amount, fare.currency),
    }));
}

/**
 * Which direction of `row` a trip card describes, for picking its fare: the
 * train number first (exact, and what the fare was keyed by), then the trip's
 * own direction_id. null when neither says — better no per-train figure than
 * the other train's.
 */
export function fareDirectionForTrip(row, trip) {
  if (!row || !trip) return null;
  const name = String(trip.trip_short_name ?? "").trim();
  if (name) {
    for (const dir of [0, 1]) {
      if (String(row[`trip_short_name_${dir}`] ?? "").trim() === name) return dir;
    }
  }
  const id = Number(trip.direction_id);
  return id === 0 || id === 1 ? id : null;
}

/**
 * Everything a timetable needs to print one direction's fare, or null:
 * { from: "¥335.5", fromClass: "Hard sleeper", classes: fareClassRows(), checkedAt: "2026-09-26" }
 * Plain strings and numbers only, so it serialises into static page props.
 */
export function directionFareSummary(row, dir) {
  const fare = directionFare(row, dir);
  if (!fare) return null;
  return {
    from: formatMoney(fare.fromPrice, fare.currency),
    fromClass: fareClassLabel(fare.seatClass),
    classes: fareClassRows(fare),
    checkedAt: fare.checkedAt ?? null,
  };
}
