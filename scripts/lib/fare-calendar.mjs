// scripts/lib/fare-calendar.mjs
// A night train's fare for every night of the next few weeks, built up a
// slice at a time.
//
// A yield-managed fare (lefrecce) is one date's price, so one sample per train
// answers "how much from" and nothing else. A traveller picking a night wants
// the price OF that night, which means one search per train per date — 25
// Intercity Notte trains over six weeks is ~1 050 searches, too many to fire at
// an operator's booking backend in one go. So each run spends a fixed budget on
// the nights that most need it (never checked, nearest first; then the
// stalest), and the calendar fills over a few nights and stays fresh after.
//
// Pure and dependency-free: the adapter does the searching, this decides what
// to search and what the result means. Exported for tests.

/** Nights ahead the calendar covers: six weeks, i.e. six rows of a month grid. */
export const FARE_CALENDAR_DAYS = 42;

/** Searches per run. ~1 s each with the adapter's spacing, so ~7 min a night. */
export const FARE_CALENDAR_BUDGET = 400;

/** A night's price older than this is dropped rather than shown. */
export const FARE_CALENDAR_MAX_AGE_DAYS = 14;

/**
 * Bumped whenever what a night's entry MEANS changes — a fix to how a search
 * answer is read. A calendar written under an older version is dropped whole
 * rather than trusted: its entries were read by the rule the fix replaced,
 * and would otherwise stay on the page for two weeks.
 *   2: departure-minute matches no longer take another tracked train
 *      (771 carried 770's fares), and a 400 reads as "no train that night".
 *   3: prices are what a standard adult pays — Young, Senior, card, group
 *      and return offers no longer count (lefrecce.mjs isStandardAdultOffer).
 */
export const FARE_CALENDAR_VERSION = 3;

const DAY_MS = 86_400_000;

function isoMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function isoPlusDays(iso, days) {
  return new Date(isoMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The nights the calendar covers: tomorrow through `days` nights out. */
export function calendarWindow(today, days = FARE_CALENDAR_DAYS) {
  const out = [];
  for (let i = 1; i <= days; i++) out.push(isoPlusDays(today, i));
  return out;
}

/**
 * A calendar with the nights that no longer mean anything taken out: nights
 * already past (or beyond the window) and checks too old to stand behind.
 *
 * Shape: { currency, nights: { "2026-10-18": { classes: { couchette: 53.6 },
 * checkedAt: "2026-09-27" } | { none: true, checkedAt } } }. `none` is a night
 * the search answered without our train or without a berth on sale — the train
 * does not run, or its berths are gone; either way there is nothing to book.
 * A source may keep more beside `classes` (Nightjet: each night's clocks, its
 * seat price and the product each figure is, and why a `none` night has no
 * fare — scripts/lib/nj-fares.mjs). Every reader of a price reads `classes`
 * alone, which is what keeps a seat price kept for checking from ever being
 * quoted as a fare.
 */
export function pruneCalendar(
  calendar,
  {
    today,
    days = FARE_CALENDAR_DAYS,
    maxAgeDays = FARE_CALENDAR_MAX_AGE_DAYS,
  } = {},
) {
  const window = new Set(calendarWindow(today, days));
  const todayMs = isoMs(today);
  const nights = {};
  const current = calendar?.version === FARE_CALENDAR_VERSION;
  for (const [date, entry] of Object.entries(current ? (calendar?.nights ?? {}) : {})) {
    if (!window.has(date) || !entry || typeof entry !== "object") continue;
    const checkedMs = isoMs(entry.checkedAt);
    if (
      !Number.isFinite(checkedMs) ||
      (todayMs - checkedMs) / DAY_MS > maxAgeDays
    )
      continue;
    nights[date] = entry;
  }
  return { version: FARE_CALENDAR_VERSION, currency: calendar?.currency ?? null, nights };
}

/**
 * What to search tonight, most useful first, at most `budget` searches:
 * nights never checked (nearest first, trains interleaved so every train gets
 * its next weeks before any train gets its far ones), then the stalest checks.
 * A night checked today is never searched again the same day.
 *
 * `nearDays` (opt-in, default 0) puts the nights a traveller is most likely to
 * book ahead of everything else. Without it a near night checked yesterday
 * waits behind every never-checked far one and then behind every older check,
 * so a budget that goes round a full Nightjet calendar in about 2.6 nights
 * leaves tomorrow's fare as old as the one six weeks out — up to three days.
 * With it the order is: (0) never-checked nights within `nearDays`, (1)
 * nights within `nearDays` checked before today, stalest first, (2) never-
 * checked farther nights, nearest first, (3) the rest, stalest first. At 0
 * the first two tiers are empty and the order is exactly the one above.
 *
 * @param {Record<string, object>} calendars trainKey → pruned calendar
 * @returns {{ key: string, date: string }[]}
 */
export function planFareSearches(
  calendars,
  { today, days = FARE_CALENDAR_DAYS, budget = FARE_CALENDAR_BUDGET, nearDays = 0 } = {},
) {
  const dates = calendarWindow(today, days);
  const candidates = [];
  for (const key of Object.keys(calendars ?? {}).sort()) {
    const nights = calendars[key]?.nights ?? {};
    dates.forEach((date, i) => {
      const checkedAt = nights[date]?.checkedAt ?? null;
      if (checkedAt === today) return;
      candidates.push({ key, date, i, checkedAt });
    });
  }
  // `i` is 0 for tomorrow, so "within nearDays" is i < nearDays.
  const tier = (c) => (c.i < nearDays ? 0 : 2) + (c.checkedAt ? 1 : 0);
  candidates.sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    // Within a tier both nights were checked or neither was.
    if (a.checkedAt && a.checkedAt !== b.checkedAt)
      return a.checkedAt < b.checkedAt ? -1 : 1;
    if (a.i !== b.i) return a.i - b.i;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return candidates
    .slice(0, Math.max(0, budget))
    .map(({ key, date }) => ({ key, date }));
}

/** The cheapest berth a night sells, as [seatClass, amount], or null. */
export function cheapestClass(classes) {
  let best = null;
  for (const [cls, amount] of Object.entries(classes ?? {})) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!best || amount < best[1]) best = [cls, amount];
  }
  return best;
}

/**
 * The train's headline fare: its cheapest night in the calendar, in the shape
 * every other surface already reads ({ fromPrice, currency, seatClass,
 * classes, sampledAt, travelDate }). A tie keeps the earlier night — the
 * nearer date is the more useful one to name. null when no night is priced.
 *
 * `classes` is each class's OWN cheapest night across the calendar, with the
 * night it is for in `classDates` — not the classes of the night that won.
 * The first European Sleeper calendar is why: the cheapest night was a €40
 * last-minute deal for tomorrow, and that night's regular couchette was
 * €159.99, so the map panel printed "Couchette from €159.99" for a train whose
 * couchettes start at €59.99 on other nights. A class's "from" is that class's
 * minimum, and the date travels with it so the figure stays one night's price.
 * `dealLanding` names the page the cheapest last-minute deal is sold from
 * (scripts/lib/es-fare-calendar.mjs), where the calendar carries one.
 */
export function cheapestNight(calendar) {
  let best = null;
  const classes = {};
  const classDates = {};
  const dealLandings = {};
  for (const date of Object.keys(calendar?.nights ?? {}).sort()) {
    const entry = calendar.nights[date];
    for (const [cls, amount] of Object.entries(entry?.classes ?? {})) {
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (classes[cls] == null || amount < classes[cls]) {
        classes[cls] = amount;
        classDates[cls] = date;
        if (entry.deal?.landing) dealLandings[cls] = entry.deal.landing;
        else delete dealLandings[cls];
      }
    }
    const c = cheapestClass(entry?.classes);
    if (!c) continue;
    if (!best || c[1] < best.fromPrice) {
      best = {
        fromPrice: c[1],
        currency: calendar.currency,
        seatClass: c[0],
        sampledAt: entry.checkedAt,
        travelDate: date,
      };
    }
  }
  if (!best || !best.currency) return null;
  const out = { ...best, classes, classDates };
  // The deal class with the lowest price, if any carries a landing page.
  const deal = Object.keys(dealLandings).sort((a, b) => classes[a] - classes[b])[0];
  if (deal) out.dealLanding = dealLandings[deal];
  return out;
}
