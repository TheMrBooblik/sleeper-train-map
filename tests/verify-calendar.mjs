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
