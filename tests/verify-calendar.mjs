// tests/verify-calendar.mjs
// Round-trip tests for the canonical service calendar.
// Run: npm run verify-calendar
import assert from "node:assert";
import {
  parseBotServiceString,
  parseGtfsCalendar,
  renderCalendar,
} from "../src/pages/api/lib/calendar.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function roundTrip(input) {
  assert.strictEqual(renderCalendar(parseBotServiceString(input)), input, input);
}

/**
 * Some inputs spell a calendar more verbosely than the renderer does
 * ("Saturday" for "Sat", a repeated year in a same-year range). Those are
 * canonicalised rather than preserved, so the contract is that rendering is a
 * FIXED POINT: render once, and rendering again changes nothing. Every one of
 * the 70 distinct service strings in the published payload satisfies this.
 */
function stableRender(input, expected) {
  const once = renderCalendar(parseBotServiceString(input));
  assert.strictEqual(once, expected, input);
  assert.strictEqual(renderCalendar(parseBotServiceString(once)), once, once);
}

check("BoT day-list round-trips", () => {
  roundTrip("2026: Mon, Wed, Fri");
  roundTrip("2026: Tue, Thu, Sun");
});
check("BoT daily round-trips", () => {
  roundTrip("2026: Daily");
});
check("BoT seasonal range round-trips", () => {
  roundTrip("2026/06/22-08/30: Daily");
});
check("bare frequency round-trips", () => {
  roundTrip("Daily");
  roundTrip("Mon, Wed, Fri, Sun");
});
check("unparseable input survives as note", () => {
  roundTrip("runs when the moon is full");
  roundTrip("2025/26 winter: alternate days");
});
check("cross-year range round-trips — renderCalendar's own output", () => {
  // This is the shape renderCalendar emits when validFrom/validUntil span two
  // years. Until the parser learned to read it back, six legs of the published
  // payload arrived as unparseable notes because the module could not re-read
  // what it had itself written.
  roundTrip("2026-12-14 – 2027-09-06: Mon, Wed, Fri");
  const cal = parseBotServiceString("2024-01-01 – 2030-12-31: Wed, Sun");
  assert.strictEqual(cal.validFrom, "2024-01-01");
  assert.strictEqual(cal.validUntil, "2030-12-31");
  assert.deepStrictEqual(cal.daysOfWeek, ["wed", "sun"]);
  assert.strictEqual(cal.note, null);
});
check('"Daily, except X" resolves to the six days it means', () => {
  const cal = parseBotServiceString("2026: Daily, except Sat");
  assert.deepStrictEqual(cal.daysOfWeek, ["mon", "tue", "wed", "thu", "fri", "sun"]);
  assert.strictEqual(cal.note, null);
  roundTrip("2026: Daily, except Sat");
  // Long day names and a full-year range are canonicalised, not lost.
  stableRender(
    "2026/03/27-11/01: Daily, except Saturday",
    "2026/03/27-11/01: Daily, except Sat",
  );
});
check("range with the year repeated on both sides parses", () => {
  const cal = parseBotServiceString("2026/06/13-2026/09/06: Daily");
  assert.strictEqual(cal.validFrom, "2026-06-13");
  assert.strictEqual(cal.validUntil, "2026-09-06");
  stableRender("2026/06/13-2026/09/06: Daily", "2026/06/13-09/06: Daily");
});
check("cadence is kept as cadence, never as a weekday list", () => {
  // "Every 2nd day" says how often, not which days. Inventing a day list here
  // is what makes a planner claim a train runs on a date nobody knows about:
  // 50 legs of the published payload say exactly this.
  const cal = parseBotServiceString("2026: Every 2nd day");
  assert.deepStrictEqual(cal.daysOfWeek, []);
  assert.strictEqual(cal.cadence, "Every 2nd day");
  assert.strictEqual(cal.note, null);
  roundTrip("2026: Every 2nd day");
  roundTrip("2026: 2-3 times per week");
  assert.strictEqual(parseBotServiceString("2026: Every other day").cadence, "Every other day");
});
check("German day spelling and the 'Son' slip are read as Sunday", () => {
  stableRender("2026: Mon, Wed, Fri, Sat, Son", "2026: Mon, Wed, Fri, Sat, Sun");
  assert.deepStrictEqual(
    parseBotServiceString("2026: Montag, Sonntag").daysOfWeek,
    ["mon", "sun"],
  );
});
check("a day list that is only partly readable stays a note", () => {
  // Half-understood is worse than not understood: it would silently drop days.
  const cal = parseBotServiceString("2026: Mon, whenever, Fri");
  assert.strictEqual(cal.note, "2026: Mon, whenever, Fri");
  assert.deepStrictEqual(cal.daysOfWeek, []);
});
check("parse extracts structure", () => {
  const cal = parseBotServiceString("2026/06/22-08/30: Mon, Sat");
  assert.strictEqual(cal.validFrom, "2026-06-22");
  assert.strictEqual(cal.validUntil, "2026-08-30");
  assert.deepStrictEqual(cal.daysOfWeek, ["mon", "sat"]);
  assert.strictEqual(cal.note, null);
});
check("day order normalised to week order", () => {
  const cal = parseBotServiceString("2026: Fri, Mon");
  assert.deepStrictEqual(cal.daysOfWeek, ["mon", "fri"]);
  assert.strictEqual(renderCalendar(cal), "2026: Mon, Fri");
});
check("empty/null input is empty calendar", () => {
  assert.deepStrictEqual(parseBotServiceString(null).daysOfWeek, []);
  assert.strictEqual(renderCalendar(parseBotServiceString("")), null);
});
check("GTFS calendar parses days and dates", () => {
  const cal = parseGtfsCalendar({
    monday: "1",
    tuesday: 0,
    wednesday: "1",
    thursday: 0,
    friday: 0,
    saturday: 0,
    sunday: "1",
    start_date: "20260609",
    end_date: "20261212",
  });
  assert.deepStrictEqual(cal.daysOfWeek, ["mon", "wed", "sun"]);
  assert.strictEqual(cal.validFrom, "2026-06-09");
  assert.strictEqual(cal.validUntil, "2026-12-12");
  assert.strictEqual(renderCalendar(cal), "2026/06/09-12/12: Mon, Wed, Sun");
});
check("GTFS all-week renders Daily", () => {
  const cal = parseGtfsCalendar({
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
    start_date: "20260101",
    end_date: "20261231",
  });
  assert.strictEqual(renderCalendar(cal), "2026: Daily");
});

console.log(`\n[verify-calendar] ${passed} checks passed`);
