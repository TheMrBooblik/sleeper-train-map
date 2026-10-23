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
 *
 * Input is one record per train direction, with its days as
 * fareCalendarDays() lays them out (src/lib/fareCalendarView.mjs).
 * Dependency-free `.mjs` with fixed
 * date tables, no Intl: the page is server-rendered and hydrated, and the
 * module runs in raw node under `npm run verify-fare-overview`.
 */
import { formatNight, isoPlusDays, weekdayIndex } from "./fareCalendarView.mjs";
import { FARE_CLASS_LABELS, formatMoney, isDealClass } from "./fareClasses.mjs";

/** How many days ahead the weekend list looks (two Friday/Saturday pairs). */
export const WEEKEND_HORIZON_DAYS = 16;

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
 *     may carry `href`, its dated booking link, and `deal.href`) }
 * @param {object} opts
 * @param {string} opts.today  "YYYY-MM-DD", the build date
 * @param {(amount: number, currency: string) => number|null} [opts.toEur]
 */
export function buildFareOverview(trains, { today, toEur = null } = {}) {
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
  };
}

function groupThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The page's questions, each answered from the overview itself and left out
 * when the data cannot answer it (no deals on sale). Plain strings, so they double as FAQPage structured data.
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
  items.push({
    q: "How are these prices collected?",
    a: "Every night we ask each operator's own booking system for the cheapest couchette or sleeper place one adult can buy on every night of the coming weeks — seats, child and youth fares and restricted offers are left out. Each price links to the operator's own booking page for that night; we do not sell tickets ourselves.",
  });
  return items;
}
