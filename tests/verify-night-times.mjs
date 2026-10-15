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
  clockKey,
  formatClockRange,
  journeyTimesTheEnds,
  nightClock,
  nightTimesSummary,
  stopsForNight,
} from "../src/lib/nightTimes.mjs";
import { fareCalendarDays } from "../src/lib/fareCalendarView.mjs";
import { servedTrainsData } from "../src/pages/api/lib/operator-trains-handler.mjs";
import {
  calendarClocks,
  fillTimetableVariants,
  planTimetableReads,
  runClock,
} from "../scripts/lib/nj-timetable-variants.mjs";

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

// ── One timetable read per clock ────────────────────────────────────────────
// Vienna keeps UTC+2 until 25 October 2026, so 18:15Z is 20:15 there.
const at = (date, hhmm, hours = 2) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h - hours) * 60 + m) * 60_000).toISOString();
};
const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const answer = (night, dep, arr, via = "Köln Hbf") => ({
  lineName: "NJ 403",
  stations: [
    { id: "8400058", name: "Amsterdam Centraal", departure: at(night, dep) },
    { id: "8000207", name: via, arrival: at(night, "23:00"), departure: at(night, "23:05") },
    { id: "8503000", name: "Zürich HB", arrival: at(nextDay(night), arr) },
  ],
});
const train = () => ({
  ...answer("2026-10-15", "21:01", "08:42"),
  fareCalendar: {
    journey: { from: "Amsterdam Centraal", to: "Zürich HB" },
    nights: {
      "2026-10-16": priced("2026-10-16T21:01", "2026-10-17T08:42"), // the run's own clock
      "2026-10-17": priced("2026-10-17T20:15", "2026-10-18T08:05"),
      "2026-10-18": priced("2026-10-18T20:15", "2026-10-19T08:05"),
      "2026-10-19": priced("2026-10-19T20:01", "2026-10-20T07:41"),
      "2026-10-20": { none: true, checkedAt: "2026-10-15", reason: "noBerth" },
    },
  },
});

check("a train's own run and its calendar's clocks", () => {
  assert.deepStrictEqual(runClock(train()), { night: "2026-10-15", key: "21:01>08:42+1" });
  const clocks = calendarClocks(train(), "2026-10-15");
  assert.deepStrictEqual([...clocks.keys()], ["21:01>08:42+1", "20:15>08:05+1", "20:01>07:41+1"]);
  assert.deepStrictEqual(clocks.get("20:15>08:05+1"), ["2026-10-17", "2026-10-18"]);
  assert.strictEqual(clockKey({ departure: "20:15", arrival: "08:05", arrivalDays: 1 }), "20:15>08:05+1");
  const carTrain = train();
  carTrain.stations[0].name = "Wien Hbf (Autoreisezuganlage)";
  carTrain.fareCalendar.journey.from = "Wien Hbf";
  assert.strictEqual(calendarClocks(carTrain, "2026-10-15").size, 0, "another end's clocks");
});

check("one read per clock the run does not answer, on its nearest night", () => {
  const { reads } = planTimetableReads({ "NJ 403": train() }, null, { today: "2026-10-15" });
  assert.deepStrictEqual(
    reads.map((r) => [r.clock, r.night]),
    [
      ["20:15>08:05+1", "2026-10-17"],
      ["20:01>07:41+1", "2026-10-19"],
    ],
  );
});

check("a recent read is reused, an old one read again", () => {
  const stations = answer("2026-10-12", "20:15", "08:05").stations;
  const previous = {
    "NJ 403": {
      timetableVariants: {
        "20:15>08:05+1": { readAt: "2026-10-12", night: "2026-10-12", stations },
        "20:01>07:41+1": { readAt: "2026-10-01", night: "2026-10-01", stations },
        "19:00>06:00+1": { readAt: "2026-10-14", night: "2026-10-14", stations },
      },
    },
  };
  const { reads, carried } = planTimetableReads({ "NJ 403": train() }, previous, { today: "2026-10-15" });
  assert.deepStrictEqual(reads.map((r) => r.clock), ["20:01>07:41+1"]);
  // A clock the calendar no longer shows is not carried.
  assert.deepStrictEqual(Object.keys(carried.get("NJ 403")), ["20:15>08:05+1"]);
});

const run = async (fetchTrain, opts = {}) => {
  const trains = { "NJ 403": train() };
  const asked = [];
  const stats = await fillTimetableVariants(trains, opts.previous ?? null, {
    today: "2026-10-15",
    fetchTrain: async (n, d) => {
      asked.push(`${n} ${d}`);
      return fetchTrain(n, d);
    },
    spacingMs: 0,
    ...opts,
  });
  return { trains, stats, asked };
};

const asyncChecks = [];
const checkAsync = (name, fn) => asyncChecks.push([name, fn]);

checkAsync("an answer on the night and clock asked for is kept", async () => {
  const { trains, stats, asked } = await run((n, d) =>
    d === "2026-10-17" ? answer(d, "20:15", "08:05", "Düsseldorf Hbf") : answer(d, "20:01", "07:41"),
  );
  assert.deepStrictEqual(asked, ["NJ 403 2026-10-17", "NJ 403 2026-10-19"]);
  assert.strictEqual(stats.kept, 2);
  const v = trains["NJ 403"].timetableVariants["20:15>08:05+1"];
  assert.strictEqual(v.night, "2026-10-17");
  assert.strictEqual(v.readAt, "2026-10-15");
  assert.strictEqual(v.stations[1].name, "Düsseldorf Hbf", "a diversion's own stops");
  assert.deepStrictEqual(Object.keys(v.stations[0]).sort(), ["arrival", "departure", "id", "name"]);
});

checkAsync("an answer about another night or another clock is dropped", async () => {
  const { trains, stats } = await run((n, d) =>
    // Asked for the 17th, answered with the next run; asked for the 19th,
    // answered on that night but at a clock that moved again.
    d === "2026-10-17" ? answer("2026-10-18", "20:15", "08:05") : answer(d, "20:31", "07:41"),
  );
  assert.strictEqual(stats.mismatched, 2);
  assert.strictEqual(trains["NJ 403"].timetableVariants, undefined);
});

checkAsync("the budget and repeated failures stop the reads", async () => {
  const capped = await run((n, d) => answer(d, "20:15", "08:05"), { reads: 1 });
  assert.strictEqual(capped.stats.read, 1);
  assert.strictEqual(capped.stats.capped, true);
  const many = { "NJ 403": train() };
  for (let d = 21; d <= 30; d++) {
    many["NJ 403"].fareCalendar.nights[`2026-10-${d}`] = priced(`2026-10-${d}T19:${d}`, `2026-10-${d + 1}T08:00`);
  }
  let calls = 0;
  const stats = await fillTimetableVariants(many, null, {
    today: "2026-10-15",
    fetchTrain: async () => {
      calls++;
      return null;
    },
    spacingMs: 0,
  });
  assert.strictEqual(calls, 5, "five unanswered reads in a row end the pass");
  assert.strictEqual(stats.stopped, true);
});

check("a night's own timetable replaces the stop list whole", () => {
  const own = [
    { name: "Amsterdam Centraal", departure: "20:15", arrival: "" },
    { name: "Düsseldorf Hbf", departure: "22:40", arrival: "22:38" },
    { name: "Zürich HB", departure: "", arrival: "08:05" },
  ];
  const r = stopsForNight(STOPS, { departure: "20:15", arrival: "08:05" }, own);
  assert.strictEqual(r.ownTimetable, true);
  assert.strictEqual(r.stops.length, 3);
  assert.strictEqual(r.stops[1].name, "Düsseldorf Hbf");
  assert.strictEqual(r.stops[1].arrival, "22:38");
  // Without one, the run's list with the stops in between cleared, as before.
  assert.strictEqual(stopsForNight(STOPS, { departure: "21:01", arrival: "08:05" }, null).ownTimetable, false);
});

check("the panel's trains file carries no per-night timetables", () => {
  const t = train();
  t.timetableVariants = { "20:15>08:05+1": { readAt: "2026-10-15", night: "2026-10-17", stations: [] } };
  const served = servedTrainsData({ trains: { "NJ 403": t } });
  assert.ok(!("timetableVariants" in served.trains["NJ 403"]));
  assert.ok(!("fareCalendar" in served.trains["NJ 403"]));
});

for (const [name, fn] of asyncChecks) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log(`\n${passed} checks passed`);
