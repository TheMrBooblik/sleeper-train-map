// tests/verify-night-times.mjs
// A train's clock night by night (src/lib/nightTimes.mjs): the range the map
// panel prints for a Nightjet whose times move with engineering works, and the
// connection page's stop list retimed to the night picked in its fare
// calendar. No network.
// Run: npm run verify-night-times
//
// Synthetic calendars pin each rule; the committed Nightjet trains file is read
// for invariants only, since it is rewritten nightly.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatClockRange,
  journeyTimesTheEnds,
  nightClock,
  nightTimesSummary,
  stopsForNight,
} from "../src/lib/nightTimes.mjs";
import { fareCalendarDays } from "../src/lib/fareCalendarView.mjs";
import { servedTrainsData } from "../src/pages/api/lib/operator-trains-handler.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const priced = (dep, arr) => ({ classes: { couchette: 59.9 }, checkedAt: "2026-10-15", dep, arr });

// NJ 403's shape on 15 October 2026: six departures between 20:01 and 21:01.
const CALENDAR = {
  currency: "EUR",
  journey: { from: "Amsterdam Centraal", to: "Zürich HB" },
  nights: {
    "2026-10-16": priced("2026-10-16T20:15", "2026-10-17T08:05"),
    "2026-10-17": priced("2026-10-17T21:01", "2026-10-18T08:05"),
    "2026-10-18": priced("2026-10-18T20:15", "2026-10-19T07:41"),
    "2026-10-19": priced("2026-10-19T20:01", "2026-10-20T08:05"),
    "2026-10-20": { none: true, checkedAt: "2026-10-15", reason: "noBerth" },
  },
};

check("nightClock reads a night's own clock and refuses another night's", () => {
  assert.deepStrictEqual(nightClock("2026-10-17", CALENDAR.nights["2026-10-17"]), {
    departure: "21:01",
    arrival: "08:05",
    arrivalDays: 1,
  });
  // A departure dated another day is another journey's clock.
  assert.strictEqual(nightClock("2026-10-16", CALENDAR.nights["2026-10-17"]), null);
  assert.strictEqual(nightClock("2026-10-20", CALENDAR.nights["2026-10-20"]), null);
  assert.strictEqual(nightClock("2026-10-16", priced("2026-10-16T20:15", "2026-10-16T19:00")), null);
  assert.strictEqual(nightClock("2026-10-16", priced("16.10.2026 20:15", "2026-10-17T08:05")), null);
});

check("nightTimesSummary gives the range, and 'usual' only where most nights keep it", () => {
  const s = nightTimesSummary(CALENDAR);
  assert.strictEqual(s.nights, 4);
  assert.strictEqual(s.varies, true);
  assert.deepStrictEqual(s.departure, { earliest: "20:01", latest: "21:01", varies: true, usual: null });
  assert.deepStrictEqual(s.arrival, { earliest: "07:41", latest: "08:05", varies: true, usual: "08:05" });
  assert.strictEqual(formatClockRange(s.departure), "20:01–21:01");
  // `today` drops the nights already gone.
  assert.strictEqual(nightTimesSummary(CALENDAR, { today: "2026-10-17" }).departure.earliest, "20:01");
  assert.strictEqual(nightTimesSummary(CALENDAR, { today: "2026-10-18" }), null, "one night is no range");
});

check("a range is measured across midnight, not by the clock's digits", () => {
  const s = nightTimesSummary({
    nights: {
      "2026-10-16": priced("2026-10-16T23:50", "2026-10-17T07:00"),
      "2026-10-17": priced("2026-10-17T23:58", "2026-10-18T07:00"),
      "2026-10-18": priced("2026-10-18T23:50", "2026-10-18T23:59"),
    },
  });
  assert.strictEqual(s.departure.earliest, "23:50");
  // Arrivals 23:59 the same night and 07:00 the next morning: earliest is the evening.
  assert.strictEqual(s.arrival.earliest, "23:59");
  assert.strictEqual(s.arrival.latest, "07:00");
});

check("a steady clock is not a range", () => {
  const s = nightTimesSummary({
    nights: {
      "2026-10-16": priced("2026-10-16T20:11", "2026-10-17T09:47"),
      "2026-10-17": priced("2026-10-17T20:11", "2026-10-18T09:47"),
      "2026-10-18": priced("2026-10-18T20:13", "2026-10-19T09:47"),
    },
  });
  assert.strictEqual(s.varies, false, "two minutes is noise");
  assert.strictEqual(formatClockRange(s.departure), "20:11");
});

check("a car-train terminal priced as its neighbour does not time the train", () => {
  const journey = { from: "Wien Hbf", to: "Bregenz Bahnhof" };
  assert.strictEqual(journeyTimesTheEnds(journey, "Wien Hbf (Autoreisezuganlage)", "Bregenz Bahnhof"), false);
  assert.strictEqual(journeyTimesTheEnds(journey, "Wien Hbf", "Bregenz Bahnhof"), true);
  // A qualifier the priced journey keeps is the same station.
  assert.strictEqual(
    journeyTimesTheEnds({ from: "Berlin Hbf (tief)", to: "Graz Hbf" }, "Berlin Hbf (tief)", "Graz Hbf"),
    true,
  );
  // Spellings differ across sources (Brüssel/Bruxelles); only a dropped qualifier refuses.
  assert.strictEqual(journeyTimesTheEnds({ from: "Brüssel Midi", to: "Wien Hbf" }, "Bruxelles-Midi", "Wien Hbf"), true);
  assert.strictEqual(journeyTimesTheEnds(null, "A (x)", "B"), true);
});

const STOPS = [
  { name: "Amsterdam Centraal", departure: "20:15", arrival: "" },
  { name: "Utrecht Centraal", departure: "20:43", arrival: "20:41" },
  { name: "Basel SBB", departure: "06:10", arrival: "06:01" },
  { name: "Zürich HB", departure: "", arrival: "08:05" },
];

check("a night on the run's clock keeps every stop's time", () => {
  const r = stopsForNight(STOPS, { departure: "20:15", arrival: "08:05" });
  assert.strictEqual(r.sameAsRun, true);
  assert.deepStrictEqual(r.stops, STOPS);
});

check("a night on another clock retimes the ends and clears the stops between", () => {
  const r = stopsForNight(STOPS, { departure: "21:01", arrival: "08:05" });
  assert.strictEqual(r.sameAsRun, false);
  assert.strictEqual(r.stops[0].departure, "21:01");
  assert.strictEqual(r.stops[3].arrival, "08:05");
  // Today's run passes Utrecht at 20:41; this night leaves Amsterdam after that.
  assert.ok(r.stops.slice(1, 3).every((s) => !s.departure && !s.arrival));
  assert.strictEqual(STOPS[1].arrival, "20:41", "the input is not mutated");
  assert.strictEqual(stopsForNight(STOPS, null), null);
  assert.strictEqual(stopsForNight(["A", "B"], { departure: "1", arrival: "2" }), null);
});

check("fareCalendarDays carries each night's clock, unless the calendar priced other ends", () => {
  const view = fareCalendarDays(CALENDAR, { today: "2026-10-15" });
  const day = view.days.find((d) => d.date === "2026-10-17");
  assert.strictEqual(day.dep, "21:01");
  assert.strictEqual(day.arr, "08:05");
  assert.ok(!("dep" in view.days.find((d) => d.date === "2026-10-20")), "a none night has no clock");
  const untimed = fareCalendarDays(CALENDAR, { today: "2026-10-15", timed: false });
  assert.ok(untimed.days.every((d) => !("dep" in d)));
});

check("the trains file serves the range in place of the calendar", () => {
  const data = {
    uploadedAt: "2026-10-15",
    trains: {
      "NJ 403": {
        stations: [{ name: "Amsterdam Centraal" }, { name: "Zürich HB" }],
        fareCalendar: CALENDAR,
      },
      "NJ 19946": {
        stations: [{ name: "Wien Hbf (Autoreisezuganlage)" }, { name: "Bregenz Bahnhof" }],
        fareCalendar: { ...CALENDAR, journey: { from: "Wien Hbf", to: "Bregenz Bahnhof" } },
      },
    },
  };
  const served = servedTrainsData(data);
  assert.ok(!served.trains["NJ 403"].fareCalendar);
  assert.strictEqual(served.trains["NJ 403"].nightTimes.departure.earliest, "20:01");
  assert.ok(!served.trains["NJ 19946"].nightTimes, "a car-train terminal priced as Wien Hbf");
});

check("the committed Nightjet file: every served range is well formed", () => {
  const file = JSON.parse(
    fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"),
  );
  const served = servedTrainsData(file.data ?? file);
  const clock = /^\d{2}:\d{2}$/;
  let ranged = 0;
  for (const train of Object.values(served.trains)) {
    const t = train.nightTimes;
    if (!t) continue;
    assert.ok(t.nights >= 2);
    for (const r of [t.departure, t.arrival]) {
      assert.ok(clock.test(r.earliest) && clock.test(r.latest));
      assert.ok(r.usual === null || clock.test(r.usual));
    }
    if (t.varies) ranged++;
  }
  console.log(`    (${ranged} Nightjet trains with a clock that moves)`);
});

console.log(`\n${passed} checks passed`);
