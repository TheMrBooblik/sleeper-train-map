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
    travelDate: fare.travelDate ?? null,
    seatClass: fare.seatClass ?? null,
  };
}

/**
 * A fare's berth classes, cheapest first, ready to print:
 * [{ key: "hardSleeper", label: "Hard sleeper", amount: 335.5, price: "¥335.5" }, …]
 * Classes with no known label are skipped rather than printed as a code.
 *
 * `from`: prefix each price with "from" — for a dynamic (yield-managed) fare,
 * where the figure is the cheapest seen on one sampled date, not the price.
 * A fixed tariff's class price is the price, so it prints bare.
 */
export function fareClassRows(fare, { from = false } = {}) {
  if (!fare?.classes || typeof fare.classes !== "object") return [];
  return Object.entries(fare.classes)
    .filter(([key, amount]) => FARE_CLASS_LABELS[key] && Number.isFinite(amount) && amount > 0)
    .sort((a, b) => a[1] - b[1])
    .map(([key, amount]) => ({
      key,
      label: FARE_CLASS_LABELS[key],
      amount,
      price: `${from ? "from " : ""}${formatMoney(amount, fare.currency)}`,
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "for travel on 18 Oct 2026" — the night a dynamic fare was quoted for, or ""
 * when the record carries none. Callers show it for dynamic fares only: a
 * fixed tariff records its search date too, and its price does not depend on it.
 * A fixed table rather than Intl: Node's ICU and a browser's disagree on
 * punctuation, and this string is server-rendered on the connection pages.
 */
function travelDateParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  const month = m && MONTHS[Number(m[2]) - 1];
  return month ? { day: Number(m[3]), month, year: m[1] } : null;
}

export function formatTravelDate(iso) {
  const d = travelDateParts(iso);
  return d ? `for travel on ${d.day} ${d.month} ${d.year}` : "";
}

/** "18 Oct" — the same date where a line has room for little else. */
export function formatTravelDateShort(iso) {
  const d = travelDateParts(iso);
  return d ? `${d.day} ${d.month}` : "";
}

/**
 * "Couchette · ICN 797, for travel on 19 Oct 2026" — what a route-wide "from"
 * figure buys, on which train and which night. A row's `pricing` is the
 * cheaper of its two directions, so beside a timetable listing both, a bare
 * figure reads as contradicting the other direction's (or as a seat price).
 * Parts the record does not carry are left out; "" when it carries none.
 */
export function fareContext(pricing) {
  const cls = fareClassLabel(pricing?.seatClass);
  const date = formatTravelDate(pricing?.travelDate);
  const train = String(pricing?.trainName ?? "").trim();
  const where = [train, date].filter(Boolean).join(", ");
  return [cls, where].filter(Boolean).join(" · ");
}

/**
 * Everything a timetable needs to print one direction's fare, or null:
 * { from: "¥335.5", fromClass: "Hard sleeper", classes: fareClassRows(), checkedAt: "2026-09-26",
 *   travelDate: "2026-10-18" | null, travelLabel: "for travel on 18 Oct 2026" | "" }
 * Plain strings and numbers only, so it serialises into static page props.
 */
export function isDynamicPricing(pricing) {
  return pricing?.type === "dynamic";
}

export function directionFareSummary(row, dir, { dynamic = isDynamicPricing(row?.pricing) } = {}) {
  const fare = directionFare(row, dir);
  if (!fare) return null;
  return {
    from: formatMoney(fare.fromPrice, fare.currency),
    fromClass: fareClassLabel(fare.seatClass),
    classes: fareClassRows(fare, { from: dynamic }),
    checkedAt: fare.checkedAt ?? null,
    travelDate: fare.travelDate ?? null,
    // A fixed tariff (12306) is searched on a date too, but its price does
    // not depend on it: naming the date would suggest it does.
    travelLabel: dynamic ? formatTravelDate(fare.travelDate) : "",
  };
}
