/**
 * When a train is actually at each of its stops — the thing a change of trains
 * has to be checked against.
 *
 * A plan date is a train's NIGHT (the date it leaves its origin), not the date
 * you board it: NJ 19947 calls at Innsbruck at 00:47, which on the night of the
 * 7th is the morning of the 8th. Chaining two trains on "the next night" alone
 * therefore offered connections onto a train that had already left — Vienna
 * 09:39 arrival, onward "the same day" on a train calling at Vienna at 05:39 —
 * and read a 32-hour Reunification Express as arriving the morning after.
 *
 * So each stop gets an interval of minutes after midnight of the train's night,
 * [earliest, latest]. A stop with a published clock is a single instant, placed
 * on the first day that keeps the train moving forward (or on the day its source
 * states). A stop with no clock is honest about it: it lies somewhere between
 * the known stops either side of it, and a connection through it is reported as
 * possible rather than confirmed. Nothing here invents a time a page prints —
 * the intervals only decide whether two trains can meet.
 *
 * Pure and dependency-free beyond legs.mjs.
 */

import { toMinutes } from "./legs.mjs";

const DAY = 24 * 60;

/** The least time between stepping off one train and onto the next. */
export const MIN_CHANGE_MINUTES = 30;

/** Bound for a stop with nothing known after it: a train is not on the move for more. */
const OPEN_ENDED_MINUTES = 2 * DAY;

const cache = new WeakMap();

/**
 * Per stop, `{ arrival: [lo, hi], departure: [lo, hi] }` in minutes after
 * midnight of the train's night.
 * @param {object} leg - from buildLegs()
 */
export function legTimeline(leg) {
  if (!leg || typeof leg !== "object") return [];
  const hit = cache.get(leg);
  if (hit) return hit;

  const stops = leg.stops ?? [];
  const last = stops.length - 1;
  // Events in travel order: arrival then departure at every stop.
  const events = [];
  for (let k = 0; k <= last; k++) {
    const stop = stops[k];
    events.push({
      clock: stop.arrival || (k === last ? leg.arrival : ""),
      day: stop.arrivalDay,
    });
    events.push({
      clock: stop.departure || (k === 0 ? leg.departure : ""),
      day: stop.departureDay,
    });
  }

  // Place every published clock on its day.
  let cursor = null;
  for (const event of events) {
    const minutes = toMinutes(event.clock);
    if (minutes == null) continue;
    let at;
    if (Number.isInteger(event.day)) at = event.day * DAY + minutes;
    else if (cursor == null) at = minutes;
    else {
      at = minutes;
      while (at < cursor) at += DAY;
    }
    event.at = at;
    cursor = at;
  }

  // The journey's own length outranks the clocks at its end, because two clocks
  // cannot say a train runs for more than a day and the trips table can.
  const originAt = events[1].at;
  const endEvent = events[2 * last];
  if (
    Number.isFinite(originAt) &&
    Number.isFinite(leg.durationMinutes) &&
    !leg.durationSuspect &&
    !Number.isInteger(stops[last]?.arrivalDay)
  ) {
    const byDuration = originAt + leg.durationMinutes;
    if (!Number.isFinite(endEvent.at) || byDuration > endEvent.at) endEvent.at = byDuration;
  }

  // Everything else lies between its known neighbours.
  const intervals = events.map((event, i) => {
    if (Number.isFinite(event.at)) {
      // A suspect leg's clocks may be a day (or several) short at the far end.
      return leg.durationSuspect && i > 1 ? [event.at, event.at + OPEN_ENDED_MINUTES] : [event.at, event.at];
    }
    let lo = null;
    for (let j = i - 1; j >= 0; j--) {
      if (Number.isFinite(events[j].at)) {
        lo = events[j].at;
        break;
      }
    }
    let hi = null;
    for (let j = i + 1; j < events.length; j++) {
      if (Number.isFinite(events[j].at)) {
        hi = events[j].at;
        break;
      }
    }
    const from = lo ?? 0;
    let to = hi ?? from + OPEN_ENDED_MINUTES;
    // The origin's own departure is on the train's night by definition.
    if (i === 1) to = Math.min(to, DAY - 1);
    return [from, Math.max(from, to)];
  });

  const timeline = stops.map((_, k) => ({
    arrival: intervals[2 * k],
    departure: intervals[2 * k + 1],
  }));
  cache.set(leg, timeline);
  return timeline;
}

/** Minutes after the train's night at which you board and alight a segment. */
export function segmentTimes(leg, boardIndex, alightIndex) {
  const timeline = legTimeline(leg);
  const board = timeline[boardIndex];
  const alight = timeline[alightIndex];
  if (!board || !alight) return null;
  return { departure: board.departure, arrival: alight.arrival };
}

/** Whole days after the train's night on which you step off — 1 for the usual sleeper. */
export function arrivalDayOffset(times) {
  const lo = times?.arrival?.[0];
  return Number.isFinite(lo) ? Math.floor(lo / DAY) : null;
}

/**
 * Can you step off one train and onto the next?
 *
 * Both intervals are minutes after midnight of their own night; `nightsApart`
 * is how many days the second train's night falls after the first's.
 *
 * @returns {{status: "ok"|"unconfirmed"|"missed", waitMinutes: number|null}}
 *   "ok" when it works whatever the unpublished times turn out to be;
 *   "unconfirmed" when it works for some of them; "missed" when the second
 *   train has certainly left. `waitMinutes` only where both ends are exact.
 */
export function connectionBetween(arrival, departure, nightsApart) {
  if (!arrival || !departure) return { status: "unconfirmed", waitMinutes: null };
  const shift = nightsApart * DAY;
  const depLo = departure[0] + shift;
  const depHi = departure[1] + shift;
  const [arrLo, arrHi] = arrival;
  if (depHi < arrLo + MIN_CHANGE_MINUTES) return { status: "missed", waitMinutes: null };
  const exact = arrLo === arrHi && depLo === depHi;
  if (depLo >= arrHi + MIN_CHANGE_MINUTES) {
    return { status: "ok", waitMinutes: exact ? depLo - arrLo : null };
  }
  return { status: "unconfirmed", waitMinutes: null };
}
