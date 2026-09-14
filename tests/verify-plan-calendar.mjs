import assert from "node:assert/strict";
import test from "node:test";
import { routeRunsOnDate, serviceRunsOnDate } from "../src/pages/api/lib/plan-calendar.mjs";

const date = (value) => new Date(`${value}T12:00:00`);

test("daily service runs every day in its year", () => {
  assert.equal(serviceRunsOnDate("2026: Daily", date("2026-09-18")), true);
  assert.equal(serviceRunsOnDate("2026: Daily", date("2027-01-01")), false);
});

test("weekday service only runs on listed days", () => {
  assert.equal(serviceRunsOnDate("2026: Mon, Wed, Fri", date("2026-09-18")), true);
  assert.equal(serviceRunsOnDate("2026: Mon, Wed, Fri", date("2026-09-19")), false);
});

test("seasonal service respects date range", () => {
  assert.equal(serviceRunsOnDate("2026/06/22-08/30: Daily", date("2026-07-10")), true);
  assert.equal(serviceRunsOnDate("2026/06/22-08/30: Daily", date("2026-09-18")), false);
});

test("unknown service strings fail open", () => {
  assert.equal(serviceRunsOnDate("special service", date("2026-09-18")), true);
});

test("a route runs when either direction has a matching service", () => {
  assert.equal(
    routeRunsOnDate(
      { service_id_0: "2026: Mon", service_id_1: "2026: Fri" },
      date("2026-09-18"),
    ),
    true,
  );
});
