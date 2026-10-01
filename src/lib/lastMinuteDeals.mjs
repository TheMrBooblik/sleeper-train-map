/**
 * What a last-minute deal is worth to the person looking at it.
 *
 * European Sleeper sells unsold couchettes on trains leaving in the next one
 * to three weeks at a flat promo price from its own landing pages
 * (scripts/lib/es-last-minute.mjs), and those prices do not appear in its
 * fare finder. A night's calendar entry carries them as
 * `lastMinuteCouchette` / `lastMinutePrivate` beside the regular classes and
 * names the landing page in `deal.landing`. This module turns that into the
 * three things a traveller needs: how much cheaper it is than the regular
 * fare for the same kind of place that night, whether it is the cheapest way
 * onto the train at all, and what the catch is.
 *
 * Dependency-free `.mjs`, fixed strings, no Intl: the connection page is
 * server-rendered and hydrated (see fareCalendarView.mjs).
 */
import { formatMoney } from "./fareClasses.mjs";

/** Each deal class and the regular class it undercuts. */
export const DEAL_REGULAR = {
  lastMinuteCouchette: "couchette",
  lastMinutePrivate: "privateCouchette",
};

export const isDealClass = (key) => Object.hasOwn(DEAL_REGULAR, key);

/**
 * The operator's own terms for its deals, per agency id. Stated, not
 * inferred: European Sleeper publishes these on its last-minute pages and
 * in the booking a deal creates (non-refundable "easy-night" fare, a place
 * in a 5-berth Classic couchette compartment).
 */
export const LAST_MINUTE_PROGRAMMES = {
  ES: {
    name: "Last-minute deal",
    compartmentSize: 5,
    terms: [
      "A bed in a 5-berth Classic couchette compartment",
      "Bed linen and luggage included",
      "Non-refundable, no child or Interrail reductions",
      "Limited places on each train — they sell out",
    ],
    note: "European Sleeper's own fare finder does not show these prices.",
  },
};

export function lastMinuteProgramme(agencyId) {
  const ids = String(agencyId ?? "").split(/[/,+]/).map((s) => s.trim());
  for (const id of ids) if (LAST_MINUTE_PROGRAMMES[id]) return LAST_MINUTE_PROGRAMMES[id];
  return null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * One night's deal, read against the same night's regular fares, or null
 * when the night carries none:
 * { kind: "couchette" | "private", key, amount, price, regularAmount,
 *   regularPrice, savings, savingsPct, best, perPerson, landing, checkedAt }
 * `best`: the deal is cheaper than every regular place on sale that night —
 * the cheapest way onto the train, which is the claim the page may make.
 * `perPerson`: a private compartment's price split across a full one.
 * Where a night has both a couchette and a compartment deal, the couchette
 * leads (it is the one a single traveller buys).
 */
export function nightDeal(entry, { currency = "EUR", compartmentSize = 5 } = {}) {
  const classes = entry?.classes;
  if (!classes || typeof classes !== "object") return null;
  const key = ["lastMinuteCouchette", "lastMinutePrivate"].find(
    (k) => Number.isFinite(classes[k]) && classes[k] > 0,
  );
  if (!key) return null;
  const amount = classes[key];
  const regularAmount = Number.isFinite(classes[DEAL_REGULAR[key]]) ? classes[DEAL_REGULAR[key]] : null;
  const regulars = Object.entries(classes)
    .filter(([k, v]) => !isDealClass(k) && Number.isFinite(v) && v > 0)
    .map(([, v]) => v);
  const saving = regularAmount != null && regularAmount > amount ? round2(regularAmount - amount) : null;
  const kind = key === "lastMinutePrivate" ? "private" : "couchette";
  return {
    kind,
    key,
    amount,
    price: formatMoney(amount, currency),
    regularAmount,
    regularPrice: regularAmount != null ? formatMoney(regularAmount, currency) : null,
    savings: saving != null ? formatMoney(saving, currency) : null,
    savingsPct: saving != null ? Math.round((saving / regularAmount) * 100) : null,
    best: regulars.every((v) => amount < v),
    perPerson:
      kind === "private" && compartmentSize > 1
        ? formatMoney(round2(amount / compartmentSize), currency)
        : null,
    landing: entry.deal?.landing ?? null,
    checkedAt: entry.deal?.checkedAt ?? entry.checkedAt ?? null,
  };
}

/**
 * The whole calendar's deals in one line's worth of numbers, or null:
 * { count, from, fromAmount, fromDate, maxSavingsPct }. `fromDate` is the
 * cheapest deal's night (the nearer on a tie) — what "show me" selects.
 */
export function dealsSummary(days) {
  const withDeal = (days ?? []).filter((d) => d.deal);
  if (!withDeal.length) return null;
  const cheapest = withDeal.reduce((a, b) => (b.deal.amount < a.deal.amount ? b : a));
  const pcts = withDeal.map((d) => d.deal.savingsPct).filter(Number.isFinite);
  return {
    count: withDeal.length,
    from: cheapest.deal.price,
    fromAmount: cheapest.deal.amount,
    fromDate: cheapest.date,
    maxSavingsPct: pcts.length ? Math.max(...pcts) : null,
  };
}
