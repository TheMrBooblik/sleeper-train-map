// tests/verify-fare-overview.mjs
// /cheap-night-trains (src/lib/fareOverview.mjs): every priced train's
// cheapest night, every deal on sale, the weekend picks, and the weekday and
// lead-time figures. A hand-built calendar pins each rule; the committed
// payload is checked last, read the way the page reads it.
//
// Run: node tests/verify-fare-overview.mjs

import fs from "node:fs";
import path from "node:path";
import {
  buildFareOverview,
  fareOverviewFaq,
  formatPct,
  leadSentence,
  regularNightAmount,
  weekdaySentence,
  MIN_NIGHTS_PER_BUCKET,
} from "../src/lib/fareOverview.mjs";
import { fareCalendarDays, isoPlusDays, weekdayIndex } from "../src/lib/fareCalendarView.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** A train record as getFareOverviewTrains() builds it, minus booking links. */
function trainFrom(id, calendar, today, meta = {}) {
  const view = fareCalendarDays(calendar, { today });
  if (!view) return null;
  return {
    id,
    trainNumber: meta.trainNumber ?? id,
    operatorId: meta.operatorId ?? "XX",
    operatorName: meta.operatorName ?? "Operator",
    originCity: meta.originCity ?? "A",
    destinationCity: meta.destinationCity ?? "B",
    currency: view.currency,
    calendarHref: `/connections/a-to-b#fares-1`,
    days: view.days,
    nights: Object.entries(calendar.nights).map(([date, e]) => ({
      date,
      regular: e?.none ? null : regularNightAmount(e?.classes),
    })),
  };
}

console.log("regularNightAmount");
check("couchette beats a cheaper sleeper", regularNightAmount({ couchette: 80, sleeperBed: 60 }) === 80);
check("a deal is never the regular fare", regularNightAmount({ couchette: 120, lastMinuteCouchette: 40 }) === 120);
check("a seat is never a fare", regularNightAmount({ seat: 20, sleeperBed: 90 }) === 90);
check("nothing priced → null", regularNightAmount({ seat: 20 }) === null && regularNightAmount(null) === null);

console.log("formatPct");
check("signs", formatPct(-8.4) === "−8%" && formatPct(12.6) === "+13%" && formatPct(0.2) === "±0%");

// ─── A hand-built pair of calendars ─────────────────────────────────────────
// 2026-10-22 is a Thursday. Train "cheap" costs 50 on Tuesdays and 70
// otherwise; "dear" costs 300 on Tuesdays and 420 otherwise, plus one €40
// last-minute deal on the 24th. Weekday figures must read both alike.
const TODAY = "2026-10-22";
function calendar(low, high, extra = {}) {
  const nights = {};
  for (let i = 1; i <= 42; i += 1) {
    const d = isoPlusDays(TODAY, i);
    nights[d] = { classes: { couchette: weekdayIndex(d) === 1 ? low : high }, checkedAt: TODAY };
  }
  nights[isoPlusDays(TODAY, 3)] = { none: true, checkedAt: TODAY };
  return { currency: "EUR", nights: { ...nights, ...extra } };
}
const dealNight = {
  "2026-10-24": {
    classes: { couchette: 420, lastMinuteCouchette: 40 },
    checkedAt: TODAY,
    deal: { landing: "/last-minute-x", programme: "lastMinute", checkedAt: TODAY },
  },
};
const trains = [
  trainFrom("cheap", calendar(50, 70), TODAY, { originCity: "Rome" }),
  trainFrom("dear", calendar(300, 420, dealNight), TODAY, { operatorId: "ES", originCity: "Paris" }),
  // Weekly, so only six nights: too few for the figures, still listed.
  trainFrom("weekly", { currency: "EUR", nights: { "2026-10-30": { classes: { couchette: 90 } } } }, TODAY),
  // Nothing after today: not a train on this page.
  trainFrom("gone", { currency: "EUR", nights: { "2026-10-22": { classes: { couchette: 10 } } } }, TODAY),
].filter(Boolean);

console.log("buildFareOverview");
// The fixture has 12 nights a weekday; the real threshold is for the payload.
const o = buildFareOverview(trains, { today: TODAY, minNightsPerBucket: 10 });
check("a past-only calendar is not a train here", !o.cheapest.some((c) => c.id === "gone"));
check("three trains listed", o.trainCount === 3, String(o.trainCount));
check("cheapest train first", o.cheapest.map((c) => c.id).join() === "dear,cheap,weekly", o.cheapest.map((c) => c.id).join());
check("its cheapest night is the deal, marked as one", o.cheapest[0].night.price === "€40" && o.cheapest[0].night.isDeal);
check("the earliest of equal nights", o.cheapest[1].night.date === "2026-10-27", o.cheapest[1].night.date);
check("cheap nights counted within 10%", o.cheapest[1].cheapNights === 6, String(o.cheapest[1].cheapNights));
check("one deal, priced against that night's regular fare", o.deals.length === 1 && o.deals[0].regularPrice === "€420" && o.deals[0].savingsPct === 90);
check("deals summary price", o.dealsFrom === "€40");
check("weekend picks are Fridays or Saturdays within 16 days",
  o.weekend.every((w) => [4, 5].includes(weekdayIndex(w.night.date)) && w.night.date <= isoPlusDays(TODAY, 16)));
check("a no-berth night is never offered", !o.cheapest.some((c) => c.night.date === isoPlusDays(TODAY, 3)));
check("weekday figures measured per train: Tuesday alike for €50 and €300 trains",
  o.weekdays && o.weekdays.find((w) => w.day === "Tue").pct < -20 && o.weekdays.find((w) => w.day === "Fri").pct === 0,
  JSON.stringify(o.weekdays));
check("the deal does not count towards the figures (Saturday not cheap)",
  o.weekdays.find((w) => w.day === "Sat").pct >= 0);
check("weekday sentence names the extremes", /Tuesday departures were on average \d+% below/.test(weekdaySentence(o.weekdays, o.pricedNights)));

const thin = buildFareOverview(trains, { today: TODAY });
check(`fewer than ${MIN_NIGHTS_PER_BUCKET} nights a bucket (the default) → no figures, no sentence`,
  thin.weekdays === null && thin.lead === null && weekdaySentence(thin.weekdays, 1) === "" && leadSentence(thin.lead) === "");

console.log("fareOverviewFaq");
const faq = fareOverviewFaq(o);
check("deal question present when deals are on sale", faq.some((f) => /last-minute/.test(f.q)));
check("no deal question without deals", !fareOverviewFaq({ ...thin, deals: [] }).some((f) => /last-minute/.test(f.q)));
check("no weekday question without figures", !fareOverviewFaq(thin).some((f) => /day of the week/.test(f.q)));
check("answers are plain non-empty strings", faq.every((f) => typeof f.a === "string" && f.a.length > 40 && !/undefined|NaN/.test(f.a)));

// ─── The committed payload ──────────────────────────────────────────────────
console.log("published payload");
const published = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"));
const rows = Object.values(published.data.viewMap);
const asOf = String(published.generatedAt || "").slice(0, 10);
const live = [];
for (const row of rows) {
  for (const dir of [0, 1]) {
    const cal = row[`fare_calendar_${dir}`];
    if (!cal?.nights) continue;
    const t = trainFrom(`${row.route_id}-${dir}`, cal, asOf, { operatorId: row.agency_id });
    if (t) live.push(t);
  }
}
const real = buildFareOverview(live, { today: asOf });
console.log(`    ${real.trainCount} trains, ${real.pricedNights} nights, ${real.deals.length} deals, lowest ${real.lowest?.price}`);
check("the payload prices dozens of trains", real.trainCount >= 30, String(real.trainCount));
check("every listed night is after the payload's date", real.cheapest.every((c) => c.night.date > asOf));
check("every price prints", real.cheapest.every((c) => /^€\d/.test(c.night.price)), real.cheapest.map((c) => c.night.price).join());
check("sorted cheapest first", real.cheapest.every((c, i, a) => i === 0 || a[i - 1].night.amount <= c.night.amount));
check("every deal is European Sleeper's", real.deals.every((d) => d.operatorId === "ES"));
console.log(`    weekdays: ${real.weekdays?.map((w) => `${w.day} ${w.pctText}`).join(", ") ?? "—"}`);
console.log(`    lead: ${real.lead?.map((b) => `${b.label} ${b.pctText}`).join(", ") ?? "—"}`);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
