/**
 * "Does this train run on this date?" — and the discipline of answering
 * "we don't know" when we don't.
 *
 * We have weekday patterns, not a timetable. 104 of the payload's 545 legs
 * carry no operating days at all and 52 more say only how OFTEN they run
 * ("Every 2nd day"), so a third of the dataset cannot answer the question. The
 * tempting default is to let those through — the results page looks fuller. It
 * is also how a planner tells someone an Amsterdam–Milan sleeper leaves tonight
 * when the row it read says "Postponed to 2027".
 *
 * So the verdict is a tri-state, every caller renders the difference, and a
 * `confidence` rides along saying what the answer is based on. Today that is
 * "pattern" or "none"; when date-level timetable data arrives, it becomes
 * "timetable" and nothing outside this module changes.
 */

import { DAY_KEYS } from "../../pages/api/lib/calendar.mjs";
import { isPlanDate } from "./url.mjs";

/** @typedef {"runs"|"no"|"unknown"|"not-yet"|"suspended"} PlanStatus */

/** Weekday key for an ISO date, read as a calendar date (never as an instant). */
export function weekdayOf(iso) {
  if (!isPlanDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  // getUTCDay() is Sunday-first; DAY_KEYS is Monday-first.
  return DAY_KEYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

/**
 * Notes that mean "not running at all right now", as opposed to the many notes
 * that qualify a running service ("Times may vary", "Quickly booked out").
 * Anchored on the words operators actually use in this dataset.
 */
const SUSPENDED_RE = /\b(postponed|suspended|cancelled|canceled|not operating|no service)\b/i;

/** A note naming a start date the service has not reached yet. */
const STARTS_RE = /\bfrom\s+(\d{4}-\d{2}-\d{2})\b/i;

/**
 * @param {object} leg - from buildLegs()
 * @param {string} isoDate - "YYYY-MM-DD"
 * @returns {{status: PlanStatus, reason: string, confidence: "pattern"|"none",
 *           serviceText: string, note: string}}
 */
export function availabilityFor(leg, isoDate) {
  const serviceText = leg?.serviceText || "";
  const note = leg?.irregularity || "";
  const base = { serviceText, note, confidence: "none" };

  if (!isPlanDate(isoDate)) {
    return { ...base, status: "unknown", reason: "Pick a date to check this train." };
  }

  // 1. An operator note that says the service is not running beats everything
  //    the weekday pattern claims — the pattern describes a timetable that is
  //    on hold.
  if (SUSPENDED_RE.test(note)) {
    return { ...base, status: "suspended", reason: note };
  }

  // 2. A note naming a start date the plan has not reached.
  const starts = note.match(STARTS_RE);
  if (starts && isPlanDate(starts[1]) && isoDate < starts[1]) {
    return { ...base, status: "not-yet", reason: `Starts ${starts[1]}` };
  }

  // 3. Outside its own validity window. This is knowable and it is a "no", not
  //    an "unknown": the source stated the season.
  if (leg?.validFrom && isoDate < leg.validFrom) {
    return { ...base, status: "not-yet", reason: `This service starts ${leg.validFrom}` };
  }
  if (leg?.validUntil && isoDate > leg.validUntil) {
    return { ...base, status: "no", reason: `This timetable ended ${leg.validUntil}` };
  }

  // 4. A cadence without days. We know how often, never on which nights.
  if (leg?.cadence) {
    return {
      ...base,
      status: "unknown",
      reason: `Runs ${String(leg.cadence).toLowerCase()} — the operator does not publish which nights`,
    };
  }

  // 5. A weekday pattern: the one case we can actually decide.
  const days = leg?.days ?? [];
  if (days.length) {
    const weekday = weekdayOf(isoDate);
    const runs = days.includes(weekday);
    return {
      ...base,
      confidence: "pattern",
      status: runs ? "runs" : "no",
      reason: runs ? "" : `Runs ${serviceText || days.join(", ")}`,
    };
  }

  // 6. Nothing to go on. Say so — do not let it through as a "yes".
  return {
    ...base,
    status: "unknown",
    reason: leg?.serviceNote
      ? `Operating days recorded as "${leg.serviceNote}"`
      : "We don't have operating days for this train yet",
  };
}

/** Order results by how much we can stand behind them. */
export const STATUS_RANK = { runs: 0, unknown: 1, "not-yet": 2, no: 3, suspended: 4 };

/** True for a status a traveller could plausibly act on for this date. */
export function isOfferable(status) {
  return status === "runs" || status === "unknown";
}

/** Short badge label per status — one wording everywhere. */
export const STATUS_LABEL = {
  runs: "Runs this night",
  unknown: "Days unconfirmed",
  no: "Not this night",
  "not-yet": "Not running yet",
  suspended: "Suspended",
};
