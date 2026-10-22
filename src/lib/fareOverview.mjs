/**
 * Every priced night train on one page: where the cheap nights are.
 *
 * The connection pages answer "how much is this train, which night?" one
 * corridor at a time. A traveller with flexible plans asks the other way
 * round — "which sleeper is cheap in the next few weeks, and when?" — and
 * nothing on the site could answer it: European Sleeper's last-minute and
 * flash deals sat on four separate pages (and are not in the operator's own
 * fare finder at all), and the cheapest night of each of ~70 calendars was
 * only visible by opening each one.
 *
 * This module turns the calendars the pages already carry into that answer:
 *   - `deals`     every deal night, soonest first
 *   - `cheapest`  each train's cheapest night, cheapest train first
 *   - `weekend`   each train's cheapest Friday or Saturday night in the next
 *                 two weekends, for a weekend away
 *   - `weekdays` / `lead`  what the calendars say about when it is cheaper to
 *                 travel and how far ahead — measured, per train, against that
 *                 train's own typical fare, so a €300 sleeper does not drown a
 *                 €50 couchette
 *
 * Input is one record per train direction, with its days as
 * fareCalendarDays() lays them out (src/lib/fareCalendarView.mjs) plus the
 * night's raw classes for the statistics. Dependency-free `.mjs` with fixed
 * date tables, no Intl: the page is server-rendered and hydrated, and the
 * module runs in raw node under `npm run verify-fare-overview`.
 */
import { formatNight, isoPlusDays, weekdayIndex, WEEKDAYS } from "./fareCalendarView.mjs";
import { credibleClasses, FARE_CLASS_LABELS, formatMoney, isCouchetteClass, isDealClass } from "./fareClasses.mjs";

const DAY_MS = 86_400_000;
const isoMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/** Days between two "YYYY-MM-DD" dates. */
export function daysBetween(from, to) {
  return Math.round((isoMs(to) - isoMs(from)) / DAY_MS);
}

/** Lead-time buckets for the "how far ahead" figure, in days after today. */
export const LEAD_BUCKETS = [
  { key: "week", label: "In the next 7 days", min: 1, max: 7 },
  { key: "weeks", label: "1–3 weeks ahead", min: 8, max: 21 },
  { key: "month", label: "3–6 weeks ahead", min: 22, max: 42 },
];

/**
 * A train needs this many regular-fare nights before it counts towards the
 * weekday and lead-time figures: fewer, and its "typical fare" is a guess.
 */
export const MIN_NIGHTS_FOR_STATS = 10;

/**
 * And the figures need this many nights behind each bucket before the page
 * states them at all — a percentage over a handful of nights is noise.
 */
export const MIN_NIGHTS_PER_BUCKET = 60;

/** How many days ahead the weekend list looks (two Friday/Saturday pairs). */
export const WEEKEND_HORIZON_DAYS = 16;

/**
 * The regular fare a night is compared on: its cheapest couchette, else its
 * cheapest other berth — never a deal (a promo price says nothing about when
 * the operator's own fares are low), never a class without a label (a seat,
 * which this map does not price), and never a berth priced at or below the
 * night's own seat (credibleClasses).
 * @param {object} entry  one night of a fare calendar
 */
export function regularNightAmount(entry) {
  if (!entry || entry.none) return null;
  const classes = credibleClasses(entry);
  let couchette = null;
  let berth = null;
  for (const [key, value] of Object.entries(classes)) {
    if (isDealClass(key) || !FARE_CLASS_LABELS[key]) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (isCouchetteClass(key)) couchette = couchette == null ? value : Math.min(couchette, value);
    else berth = berth == null ? value : Math.min(berth, value);
  }
  return couchette ?? berth;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Signed whole percent, "−8%" / "+12%" / "±0%". */
export function formatPct(pct) {
  if (!Number.isFinite(pct)) return "";
  const r = Math.round(pct);
  if (r === 0) return "±0%";
  return r > 0 ? `+${r}%` : `−${Math.abs(r)}%`;
}

/**
 * Ratio of each night's regular fare to its train's median, grouped by
 * `bucketOf(date)`. Returns a Map of bucket → { sum, n }.
 */
function relativeFares(trains, bucketOf) {
  const groups = new Map();
  for (const train of trains) {
    const nights = (train.nights ?? []).filter((n) => Number.isFinite(n.regular));
    if (nights.length < MIN_NIGHTS_FOR_STATS) continue;
    const typical = median(nights.map((n) => n.regular));
    if (!(typical > 0)) continue;
    for (const night of nights) {
      const bucket = bucketOf(night.date);
      if (bucket == null) continue;
      const g = groups.get(bucket) ?? { sum: 0, n: 0 };
      g.sum += night.regular / typical;
      g.n += 1;
      groups.set(bucket, g);
    }
  }
  return groups;
}

/**
 * How a departure weekday compares with a train's typical fare, averaged over
 * every train: [{ day: "Mon", pct, nights }] Monday first, or null when any
 * weekday has too few nights behind it to say.
 */
export function weekdayFigures(trains, minNights = MIN_NIGHTS_PER_BUCKET) {
  const groups = relativeFares(trains, (date) => weekdayIndex(date));
  const rows = WEEKDAYS.map((day, i) => {
    const g = groups.get(i);
    return g ? { day, pct: (g.sum / g.n - 1) * 100, nights: g.n } : { day, pct: null, nights: 0 };
  });
  if (rows.some((r) => r.nights < minNights)) return null;
  return rows.map((r) => ({ ...r, pct: Math.round(r.pct), pctText: formatPct(r.pct) }));
}

/**
 * The same comparison by how far ahead the night is: LEAD_BUCKETS with
 * { pct, nights }, or null when a bucket is too thin.
 */
export function leadFigures(trains, today, minNights = MIN_NIGHTS_PER_BUCKET) {
  const groups = relativeFares(trains, (date) => {
    const ahead = daysBetween(today, date);
    return LEAD_BUCKETS.find((b) => ahead >= b.min && ahead <= b.max)?.key ?? null;
  });
  const rows = LEAD_BUCKETS.map((b) => {
    const g = groups.get(b.key);
    return { key: b.key, label: b.label, pct: g ? (g.sum / g.n - 1) * 100 : null, nights: g?.n ?? 0 };
  });
  if (rows.some((r) => r.nights < minNights)) return null;
  return rows.map((r) => ({ ...r, pct: Math.round(r.pct), pctText: formatPct(r.pct) }));
}

/** The class a priced day's figure is, for "Couchette · Thu 29 Oct". */
function cellLabel(day) {
  return FARE_CLASS_LABELS[day.cellClass] || "Berth";
}

/** What a list row needs about its train. */
function trainHead(train) {
  return {
    id: train.id,
    trainNumber: train.trainNumber,
    operatorId: train.operatorId,
    operatorName: train.operatorName,
    originCity: train.originCity,
    destinationCity: train.destinationCity,
    calendarHref: train.calendarHref,
  };
}

/** One priced night as a list row shows it. */
function nightCell(day, currency) {
  return {
    date: day.date,
    dateText: formatNight(day.date),
    amount: day.amount,
    price: formatMoney(day.amount, currency),
    classLabel: cellLabel(day),
    isDeal: isDealClass(day.cellClass),
    // A deal is sold from the operator's offer page, not its ordinary search.
    href: (isDealClass(day.cellClass) ? day.deal?.href : null) ?? day.href ?? null,
  };
}

/**
 * Sort key across currencies: the euro amount where it is not in euros, via
 * `toEur` (injected, so this module stays free of the rates file). A fare
 * with no rate sorts last rather than being compared as if it were euros.
 */
function sortAmount(amount, currency, toEur) {
  if (currency === "EUR") return amount;
  const eur = toEur ? toEur(amount, currency) : null;
  return Number.isFinite(eur) ? eur : Number.POSITIVE_INFINITY;
}

/**
 * @param {object[]} trains  one per train direction:
 *   { id, trainNumber, operatorId, operatorName, originCity, destinationCity,
 *     currency, calendarHref, days: fareCalendarDays().days (each priced day
 *     may carry `href`, its dated booking link, and `deal.href`),
 *     nights: [{ date, regular }] }
 * @param {object} opts
 * @param {string} opts.today  "YYYY-MM-DD", the build date
 * @param {(amount: number, currency: string) => number|null} [opts.toEur]
 * @param {number} [opts.minNightsPerBucket]  see MIN_NIGHTS_PER_BUCKET
 */
export function buildFareOverview(trains, { today, toEur = null, minNightsPerBucket = MIN_NIGHTS_PER_BUCKET } = {}) {
  const list = (trains ?? []).filter((t) => t && Array.isArray(t.days));
  const future = (day) => day.date > today;

  const deals = [];
  const cheapest = [];
  const weekend = [];
  const weekendEnd = isoPlusDays(today, WEEKEND_HORIZON_DAYS);
  const operators = new Map();
  let pricedNights = 0;

  for (const train of list) {
    const priced = train.days.filter((d) => future(d) && d.state === "priced" && Number.isFinite(d.amount));
    if (!priced.length) continue;
    pricedNights += priced.length;
    operators.set(train.operatorId, train.operatorName);
    const head = trainHead(train);

    for (const day of priced) {
      if (!day.deal) continue;
      deals.push({
        ...head,
        date: day.date,
        dateText: formatNight(day.date),
        kind: day.deal.kind,
        programme: day.deal.programme,
        amount: day.deal.amount,
        price: day.deal.price,
        perPerson: day.deal.perPerson,
        regularPrice: day.deal.regularPrice,
        savingsPct: day.deal.savingsPct,
        best: day.deal.best,
        until: day.deal.until ? formatNight(day.deal.until) : null,
        href: day.deal.href ?? null,
      });
    }

    // The earliest of the cheapest, as the calendar itself opens on.
    const min = Math.min(...priced.map((d) => d.amount));
    const best = priced.find((d) => d.amount === min);
    const max = Math.max(...priced.map((d) => d.amount));
    cheapest.push({
      ...head,
      night: nightCell(best, train.currency),
      // Nights within 10% of the cheapest: one cheap night is luck, ten is a pattern.
      cheapNights: priced.filter((d) => d.amount <= min * 1.1).length,
      pricedNights: priced.length,
      highPrice: max > min ? formatMoney(max, train.currency) : null,
      sortAmount: sortAmount(min, train.currency, toEur),
    });

    const weekendNights = priced.filter(
      (d) => d.date <= weekendEnd && [4, 5].includes(weekdayIndex(d.date)),
    );
    if (weekendNights.length) {
      const wMin = Math.min(...weekendNights.map((d) => d.amount));
      const wBest = weekendNights.find((d) => d.amount === wMin);
      weekend.push({
        ...head,
        night: nightCell(wBest, train.currency),
        sortAmount: sortAmount(wMin, train.currency, toEur),
      });
    }
  }

  const byAmount = (a, b) =>
    a.sortAmount - b.sortAmount ||
    a.night.date.localeCompare(b.night.date) ||
    String(a.trainNumber).localeCompare(String(b.trainNumber));
  cheapest.sort(byAmount);
  weekend.sort(byAmount);
  deals.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.amount - b.amount ||
      String(a.trainNumber).localeCompare(String(b.trainNumber)),
  );

  const statTrains = list.map((t) => ({
    nights: (t.nights ?? []).filter((n) => n.date > today),
  }));

  const eurCheapest = cheapest.find((c) => Number.isFinite(c.sortAmount));
  return {
    today,
    trainCount: cheapest.length,
    pricedNights,
    pricedNightsText: groupThousands(pricedNights),
    operatorNames: [...operators.values()].sort(),
    lowest: eurCheapest
      ? { price: eurCheapest.night.price, trainNumber: eurCheapest.trainNumber }
      : null,
    deals,
    dealsFrom: deals.length ? formatMoney(Math.min(...deals.map((d) => d.amount)), "EUR") : null,
    cheapest: cheapest.map(({ sortAmount: _s, ...rest }) => rest),
    weekend: weekend.map(({ sortAmount: _s, ...rest }) => rest),
    weekdays: weekdayFigures(statTrains, minNightsPerBucket),
    lead: leadFigures(statTrains, today, minNightsPerBucket),
  };
}

/**
 * The weekday figures as a sentence, or "" — for the FAQ and the intro:
 * "Across 1,950 priced nights, Tuesday departures were 6% below a train's
 * typical fare and Friday ones 9% above." Names the cheapest and the dearest
 * day only, and says nothing when the spread is under 3 points (no real
 * difference is not a finding).
 */
export function weekdaySentence(weekdays, pricedNights) {
  if (!Array.isArray(weekdays) || !weekdays.length) return "";
  const names = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
  const low = weekdays.reduce((a, b) => (b.pct < a.pct ? b : a));
  const high = weekdays.reduce((a, b) => (b.pct > a.pct ? b : a));
  if (high.pct - low.pct < 3) {
    return `Across ${groupThousands(pricedNights)} priced nights, the day of the week made little difference: every weekday was within a few percent of a train's typical fare.`;
  }
  return `Across ${groupThousands(pricedNights)} priced nights, ${names[low.day]} departures were on average ${relative(low.pct)} a train's typical fare and ${names[high.day]} ones ${relative(high.pct)}.`;
}

/** The lead-time figures as a sentence, or "". */
export function leadSentence(lead) {
  if (!Array.isArray(lead) || lead.length !== LEAD_BUCKETS.length) return "";
  const [week, , month] = lead;
  const diff = week.pct - month.pct;
  if (Math.abs(diff) < 3) {
    return "Booking further ahead made little difference on average: nights in the coming week cost about the same as nights a month out.";
  }
  return `${diff > 0 ? "Booking ahead pays" : "Late booking was not penalised"}: nights in the coming week cost on average ${relative(week.pct)} each train's typical fare, nights three to six weeks out ${relative(month.pct)}.`;
}

/** "7% below" / "26% above" / "level with" */
function relative(pct) {
  if (pct === 0) return "level with";
  return `${Math.abs(pct)}% ${pct < 0 ? "below" : "above"}`;
}

function groupThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The page's questions, each answered from the overview itself and left out
 * when the data cannot answer it (no deals on sale, too few nights for a
 * weekday figure). Plain strings, so they double as FAQPage structured data.
 */
export function fareOverviewFaq(overview) {
  const items = [];
  const o = overview ?? {};
  const top = (o.cheapest ?? []).slice(0, 3);
  if (top.length) {
    const named = top
      .map((c) => `${c.trainNumber} ${c.originCity}–${c.destinationCity} from ${c.night.price} (${c.night.dateText})`)
      .join("; ");
    items.push({
      q: "Which night trains are cheapest right now?",
      a: `Of the ${o.trainCount} night trains we price for every night of the coming weeks, the lowest berth fares are: ${named}. Prices are per person for one bed and change with demand.`,
    });
  }
  if (o.deals?.length) {
    items.push({
      q: "Does European Sleeper sell last-minute tickets?",
      a: `Yes. European Sleeper sells unsold couchette beds on trains leaving in the next few weeks at a flat promotional price from its own offer pages, and those prices do not appear in its regular fare finder. Right now ${o.deals.length} departure${o.deals.length === 1 ? "" : "s"} carr${o.deals.length === 1 ? "ies" : "y"} one, from ${o.dealsFrom} a bed. They are non-refundable and places are limited.`,
    });
  }
  const weekday = weekdaySentence(o.weekdays, o.pricedNights);
  if (weekday) {
    items.push({
      q: "Which day of the week is cheapest for a night train?",
      a: `${weekday} The figures compare each night with the same train's typical (median) fare over the coming weeks, so they say when a given train is cheaper, not which train is.`,
    });
  }
  const lead = leadSentence(o.lead);
  if (lead) {
    items.push({
      q: "How far ahead should I book a night train?",
      a: `${lead} Night trains have few beds and most operators price them by demand, so a popular night can still sell out early — when your date is fixed, booking as soon as it is on sale is the safe choice.`,
    });
  }
  items.push({
    q: "How are these prices collected?",
    a: "Every night we ask each operator's own booking system for the cheapest couchette or sleeper place one adult can buy on every night of the coming weeks — seats, child and youth fares and restricted offers are left out. Each price links to the operator's own booking page for that night; we do not sell tickets ourselves.",
  });
  return items;
}
