// tests/verify-via-schedule.mjs
// The stop list the map panel shows when no operator feed claims the train.
// Run: npm run verify-via-schedule
//
// Worth pinning because the failure it fixes was silent and asymmetric: the
// connection page for a Back-on-Track-only train showed a stop list and the
// map panel showed none, from the same row, because the panel's schedule was a
// chain of nine feed lookups with no fallback at the end.
import assert from "node:assert";
import fs from "node:fs";
import { viaScheduleForTrip } from "../src/lib/viaSchedule.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("builds origin + via + destination with only the endpoint times", () => {
  const row = {
    route_id: 69,
    origin_trip_0: "Oslo S",
    destination_trip_0: "Bergen",
    via_0: "Sandvika - Asker - Drammen - Hokksund - Myrdal - Dale",
    origin_departure_time_0: "23:03",
    destination_arrival_time_0: "06:23",
    service_id_0: "2026: Daily, except Sat",
  };
  const s = viaScheduleForTrip(row, 0);
  assert.deepStrictEqual(
    s.stops.map((x) => x.name),
    ["Oslo S", "Sandvika", "Asker", "Drammen", "Hokksund", "Myrdal", "Dale", "Bergen"],
  );
  assert.strictEqual(s.stops[0].departure, "23:03");
  assert.strictEqual(s.stops[0].arrival, null, "the origin has no arrival");
  assert.strictEqual(s.stops.at(-1).arrival, "06:23");
  assert.strictEqual(s.stops.at(-1).departure, null, "the destination has no departure");
  // A via name carries no time, and inventing one would be worse than blank.
  assert.ok(
    s.stops.slice(1, -1).every((x) => x.arrival === null && x.departure === null),
    "intermediate stops must have no invented times",
  );
  assert.deepStrictEqual(
    s.stops.map((x) => x.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.strictEqual(s.days, "2026: Daily, except Sat");
  assert.strictEqual(s.source, "viewmap");
  assert.strictEqual(s.tripId, "via-69-0");
});

check("reads the direction it is asked for", () => {
  const row = {
    route_id: 71,
    origin_trip_0: "Trondheim S",
    destination_trip_0: "Bodø",
    via_0: "Levanger - Steinkjer",
    origin_trip_1: "Bodø",
    destination_trip_1: "Trondheim S",
    via_1: "Steinkjer - Levanger",
    origin_departure_time_1: "21:09",
  };
  assert.deepStrictEqual(
    viaScheduleForTrip(row, 1).stops.map((x) => x.name),
    ["Bodø", "Steinkjer", "Levanger", "Trondheim S"],
  );
  assert.strictEqual(viaScheduleForTrip(row, 1).stops[0].departure, "21:09");
  // Anything but 1 is direction 0, since the caller passes a boolean-ish.
  assert.strictEqual(viaScheduleForTrip(row, 0).stops[0].name, "Trondheim S");
  assert.strictEqual(viaScheduleForTrip(row, undefined).stops[0].name, "Trondheim S");
});

check("an endpoint repeated in via is not shown twice", () => {
  // An enrichment that writes the whole official stop list into via_* includes
  // the endpoints; the panel must not then open with the origin twice.
  const s = viaScheduleForTrip(
    {
      origin_trip_0: "Oslo S",
      destination_trip_0: "Bergen",
      via_0: "Oslo S - Drammen - Bergen",
    },
    0,
  );
  assert.deepStrictEqual(
    s.stops.map((x) => x.name),
    ["Oslo S", "Drammen", "Bergen"],
  );
});

check("refuses to render fewer than two stops", () => {
  assert.strictEqual(viaScheduleForTrip(null, 0), null);
  assert.strictEqual(viaScheduleForTrip(undefined, 0), null);
  assert.strictEqual(viaScheduleForTrip({}, 0), null, "an empty row has nothing to show");
  assert.strictEqual(
    viaScheduleForTrip({ origin_trip_0: "Oslo S" }, 0),
    null,
    "one endpoint alone is not a journey",
  );
  // Two endpoints and no via is a real, if short, journey.
  assert.strictEqual(
    viaScheduleForTrip({ origin_trip_0: "Oslo S", destination_trip_0: "Bergen" }, 0).stops
      .length,
    2,
  );
});

check("the panel wires it in last, so a feed always wins", () => {
  const panel = fs.readFileSync(
    "src/components/TrainDetailPanel/TrainDetailPanel.js",
    "utf8",
  );
  const chain = panel.slice(
    panel.indexOf("const schedule ="),
    panel.indexOf("const validFrom = formatCalendarDate"),
  );
  assert.ok(chain.includes("viaSchedule"), "the fallback must be in the chain");
  for (const feed of ["pkpSchedule", "detailedSchedule", "nightjetSchedule", "esSchedule"]) {
    assert.ok(
      chain.indexOf(feed) < chain.indexOf("viaSchedule"),
      `${feed} must be preferred over the via fallback`,
    );
  }
  // And the panel must not have kept its own copy of the logic.
  assert.ok(
    panel.includes("viaScheduleForTrip("),
    "the panel should call the shared helper, not inline it",
  );
});

// Every Back-on-Track-only route in the committed payload should now be able to
// show a stop list — that population is the point, not just Norway.
check("covers the routes that had no feed, across the whole payload", () => {
  const data = JSON.parse(
    fs.readFileSync("public/data/published/initial-data.json", "utf8"),
  ).data;
  const rows = Object.values(data.viewMap);
  let renderable = 0;
  for (const row of rows) {
    for (const dir of [0, 1]) {
      if (viaScheduleForTrip(row, dir)) renderable++;
    }
  }
  // Both directions of essentially every route: a row that names two endpoints
  // can always describe a journey.
  assert.ok(
    renderable > rows.length * 1.5,
    `expected most of ${rows.length * 2} directions to render, got ${renderable}`,
  );
  const norway = ["69", "70", "71", "65"].map((id) => data.viewMap[id]);
  for (const row of norway) {
    for (const dir of [0, 1]) {
      const s = viaScheduleForTrip(row, dir);
      assert.ok(s && s.stops.length >= 4, "each Norwegian direction needs a stop list");
    }
  }
});

console.log(`\n[verify-via-schedule] ${passed} checks passed`);
