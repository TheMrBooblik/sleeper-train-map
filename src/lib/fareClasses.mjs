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
  JPY: "¥",
  GEL: "₾",
  AZN: "₼",
  AMD: "֏",
};

// Currencies whose fares run to five digits, where "¥23210" is hard to read.
// Grouped with a fixed comma rather than Intl, because this string is
// server-rendered on the connection pages and Node's ICU and a browser's do not
// always agree on separators. Everything else prints exactly as before.
const GROUPED_CURRENCIES = new Set(["JPY"]);

/** "¥335.5" — the amount as the operator quotes it, with the currency's symbol. */
export function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return "";
  const symbol = CURRENCY_SYMBOLS[currency] || (currency ? `${currency} ` : "");
  const figure = GROUPED_CURRENCIES.has(currency)
    ? String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : amount;
  return `${symbol}${figure}`;
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
  // JR West's Sunrise Izumo / Seto (scripts/lib/jr-sunrise.mjs). Every figure
  // is per traveller for the whole route. Nobinobi is a numbered, carpeted
  // space on the floor — a place to lie down with no cabin, and the cheapest
  // way to sleep on the train, so it is listed rather than left out as a seat.
  nobinobi: "Nobinobi carpet space",
  soloCabin: "Solo cabin",
  singleCabin: "Single cabin",
  singleTwinCabin: "Single Twin cabin",
  twinCabinPerPerson: "Sunrise Twin, per person (2 sharing)",
  deluxeSingleCabin: "Single Deluxe cabin",
  // European Sleeper (scripts/lib/es-fares.mjs). Every figure is what one
  // adult pays, except the private compartment: one booking for the whole
  // couchette compartment, up to 5 people. Women-only compartments and seats
  // are left out at the source.
  privateCouchette: "Private compartment",
  sleeperTriple: "Sleeper, 3-bed cabin",
  sleeperDouble: "Sleeper, 2-bed cabin",
  sleeperSingle: "Sleeper, single cabin",
  comfortTriple: "Comfort sleeper, 3-bed cabin",
  comfortDouble: "Comfort sleeper, 2-bed cabin",
  comfortSingle: "Comfort sleeper, single cabin",
  // Its last-minute deals (scripts/lib/es-last-minute.mjs): sold from the
  // operator's promo pages, not its fare finder — see src/lib/lastMinuteDeals.mjs.
  lastMinuteCouchette: "Last-minute couchette",
  lastMinutePrivate: "Last-minute private compartment",
  // …and its flash sales (the same mechanism, on selected dates further out).
  flashSaleCouchette: "Flash-sale couchette",
  flashSalePrivate: "Flash-sale private compartment",
};

/**
 * Classes that are promotional deals sold outside the operator's ordinary
 * search (European Sleeper's last-minute and flash-sale pages). The map panel
 * lists them apart from the regular fares, beside the link that sells them.
 */
export const DEAL_CLASS_KEYS = new Set([
  "lastMinuteCouchette",
  "lastMinutePrivate",
  "flashSaleCouchette",
  "flashSalePrivate",
]);
export const isDealClass = (key) => DEAL_CLASS_KEYS.has(key);

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
export function fareClassRows(fare, { from = false, deals = "include" } = {}) {
  if (!fare?.classes || typeof fare.classes !== "object") return [];
  return Object.entries(fare.classes)
    .filter(([key, amount]) => FARE_CLASS_LABELS[key] && Number.isFinite(amount) && amount > 0)
    .filter(([key]) => (deals === "exclude" ? !isDealClass(key) : deals === "only" ? isDealClass(key) : true))
    .sort((a, b) => a[1] - b[1])
    .map(([key, amount]) => ({
      key,
      label: FARE_CLASS_LABELS[key],
      amount,
      price: `${from ? "from " : ""}${formatMoney(amount, fare.currency)}`,
      // The night this class's figure is for, where the source keeps a
      // calendar (each class's own cheapest night, see cheapestNight).
      date: fare.classDates?.[key] ?? null,
    }));
}

/**
 * The map panel's short list: one row per kind of place, in a fixed order.
 * European Sleeper prices up to eight regular classes a night — standard and
 * Comfort sleepers in single, 2- and 3-bed cabins beside the couchette and
 * the private compartment — and a card listing all eight said less than four
 * would. So its cabins fold by beds, each row the cheapest of its group on
 * that group's own cheapest night, and single cabins are left to the
 * connection page's calendar. A fare without those cabin classes (12306,
 * Intercity Notte, JR) is listed as it always was.
 * Each row: { key, label, amount, price, date, classKey } — `classKey` is the
 * class that won the group.
 */
const PANEL_FARE_GROUPS = [
  { key: "couchette", label: "Couchette", classes: ["couchette"] },
  { key: "cabin3", label: "3-bed cabin", classes: ["sleeperTriple", "comfortTriple"] },
  { key: "cabin2", label: "2-bed cabin", classes: ["sleeperDouble", "comfortDouble"] },
  { key: "privateCouchette", label: "Private compartment", classes: ["privateCouchette"] },
];
const CABIN_CLASSES = new Set([
  "sleeperTriple", "sleeperDouble", "sleeperSingle",
  "comfortTriple", "comfortDouble", "comfortSingle",
]);

export function panelFareRows(fare, { from = false } = {}) {
  const classes = fare?.classes;
  if (!classes || typeof classes !== "object") return [];
  if (!Object.keys(classes).some((k) => CABIN_CLASSES.has(k))) {
    return fareClassRows(fare, { from, deals: "exclude" });
  }
  const dateOf = (k) => fare.classDates?.[k] ?? null;
  const rows = [];
  for (const group of PANEL_FARE_GROUPS) {
    let best = null;
    for (const k of group.classes) {
      const amount = classes[k];
      if (!Number.isFinite(amount) || amount <= 0) continue;
      // The cheaper class wins; on a tie, the nearer night.
      const nearer = best && amount === best.amount && (dateOf(k) ?? "9") < (dateOf(best.k) ?? "9");
      if (!best || amount < best.amount || nearer) best = { k, amount };
    }
    if (!best) continue;
    rows.push({
      key: group.key,
      label: group.label,
      amount: best.amount,
      price: `${from ? "from " : ""}${formatMoney(best.amount, fare.currency)}`,
      date: dateOf(best.k),
      classKey: best.k,
    });
  }
  return rows;
}

/**
 * A direction's fare split into what the ordinary booking search sells and
 * the cheapest promotional deal, each as { fromPrice, seatClass, travelDate }
 * (the deal also { label, price, landing }), or null for a part it lacks.
 * Without per-class dates (12306, an older file) the record's own travelDate
 * stands in.
 */
export function splitDealFare(fare) {
  const rows = fareClassRows(fare);
  const pick = (row) =>
    row
      ? {
          fromPrice: row.amount,
          seatClass: row.key,
          travelDate: row.date ?? fare?.travelDate ?? null,
        }
      : null;
  const regular = pick(rows.find((r) => !isDealClass(r.key)));
  const dealRow = rows.find((r) => isDealClass(r.key));
  const deal = dealRow
    ? {
        ...pick(dealRow),
        label: dealRow.label,
        price: formatMoney(dealRow.amount, fare.currency),
        landing: fare?.dealLanding ?? null,
        programme: String(dealRow.key).startsWith("flashSale") ? "flashSale" : "lastMinute",
      }
    : null;
  return { regular, deal };
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
