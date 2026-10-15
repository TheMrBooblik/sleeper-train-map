// scripts/lib/nj-timetable-variants.mjs
// Each Nightjet night's own stop list, read once per timetable rather than
// once per night.
//
// The timetable scrape reads a train's run for one date — today's — and its
// stops and times stand for every night. Engineering works move a Nightjet by
// up to an hour, and sometimes reroute it: NJ 403 Amsterdam → Zürich leaves at
// six different times over six weeks, NJ 402's run on 15 October 2026 (19:05)
// was the exception to its usual 21:59. The fare calendar already knows each
// night's clock at the train's ends (scripts/lib/nj-fares.mjs keeps `dep`/`arr`
// per priced night), and nights on the same clock run to the same timetable.
// So the train's nights are grouped by clock (clockKey) and nightjet.com's
// train answer — the same `/destinations/train/{train}/{date}` the timetable
// scrape reads — is asked for ONE night of each clock the run does not already
// answer: on 15 October that was 101 clocks across 32 trains, about 70 reads
// beyond the run, against ~3 000 for every night.
//
// An answer is kept only when it is that night's journey on that clock: its
// first departure on the night asked about, and its clock equal to the one the
// price search gave. Anything else (the next run, a works timing that moved
// again since the price was read) is dropped, and the page keeps the run's
// times with the stops in between left blank for that night. A timetable read
// within READ_MAX_AGE_DAYS is reused while its clock is still in the calendar,
// so a quiet night asks for nothing new.
//
// The calendar's clocks are at the priced ends (pricingEnds); a train priced
// at a neighbouring station (`Wien Hbf (Autoreisezuganlage)` as `Wien Hbf`)
// has clocks for another stop, and gets no timetables (journeyTimesTheEnds).

import { clockKey, journeyTimesTheEnds, nightClock } from "../../src/lib/nightTimes.mjs";
import { viennaDate, viennaDateTime } from "./nj-fares.mjs";

/** The most reads one night may spend. 15 October needed ~70. */
export const NJ_TIMETABLE_READS_PER_RUN = 120;
/** A timetable read this many days ago is still trusted for its clock. */
export const READ_MAX_AGE_DAYS = 7;
/** This many unanswered reads in a row is the host turning us away. */
const MAX_CONSECUTIVE_FAILURES = 5;
const SPACING_MS = 1000;

const DAY_MS = 86_400_000;
const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** A train's (or an answer's) own run: its night and its clock key, or null. */
export function runClock(train) {
  const stations = Array.isArray(train?.stations) ? train.stations : [];
  if (stations.length < 2) return null;
  const first = stations[0];
  const last = stations[stations.length - 1];
  const dep = viennaDateTime(first.departure ?? first.arrival ?? null);
  const arr = viennaDateTime(last.arrival ?? last.departure ?? null);
  const night = viennaDate(first.departure ?? first.arrival ?? null);
  if (!dep || !arr || !night) return null;
  const clock = nightClock(night, { dep, arr });
  return clock ? { night, key: clockKey(clock) } : null;
}

/**
 * The clocks a train's calendar runs to after `today`, each with its nights in
 * date order: Map(key → ["2026-10-17", …]). Empty for a train whose calendar
 * priced other ends than the train's own.
 */
export function calendarClocks(train, today) {
  const out = new Map();
  const calendar = train?.fareCalendar;
  const stations = Array.isArray(train?.stations) ? train.stations : [];
  if (!calendar?.nights || stations.length < 2) return out;
  if (!journeyTimesTheEnds(calendar.journey, stations[0].name, stations[stations.length - 1].name)) {
    return out;
  }
  for (const night of Object.keys(calendar.nights).sort()) {
    if (night <= today) continue;
    const key = clockKey(nightClock(night, calendar.nights[night]));
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(night);
  }
  return out;
}

/** Only what the page reads back: names, ids and the two clocks. */
function compactStations(stations) {
  return stations.map((s) => ({
    id: s.id ?? null,
    name: s.name,
    arrival: s.arrival ?? null,
    departure: s.departure ?? null,
  }));
}

/**
 * What tonight must read and what it may reuse. Per train, every clock in its
 * calendar other than its own run's is either carried from last night's file
 * (read within READ_MAX_AGE_DAYS) or planned as one read on its nearest
 * night. Reads are ordered by night, nearest first, so a budget cut costs the
 * far weeks.
 *
 * @returns {{ reads: { key: string, train: string, clock: string, night: string }[],
 *             carried: Map<string, object> }}  `carried` is train key →
 *   { clock: variant } to start from.
 */
export function planTimetableReads(trains, previous, { today }) {
  const reads = [];
  const carried = new Map();
  for (const [key, train] of Object.entries(trains ?? {})) {
    const clocks = calendarClocks(train, today);
    if (!clocks.size) continue;
    const own = runClock(train)?.key ?? null;
    const before = previous?.[key]?.timetableVariants ?? {};
    const kept = {};
    for (const [clock, nights] of clocks) {
      if (clock === own) continue;
      const old = before[clock];
      if (old?.readAt && daysBetween(old.readAt, today) <= READ_MAX_AGE_DAYS && old.stations?.length >= 2) {
        kept[clock] = old;
        continue;
      }
      reads.push({ key, train: train.lineName ?? key, clock, night: nights[0] });
    }
    carried.set(key, kept);
  }
  reads.sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : a.key.localeCompare(b.key)));
  return { reads, carried };
}

/**
 * Read the planned timetables and set each train's `timetableVariants`
 * ({ "21:54>08:59+1": { readAt, night, stations } }) to the clocks its
 * calendar still runs to. Never throws: a failure costs that night's
 * timetable, which the page then shows with blank intermediate times.
 *
 * @param {Record<string, object>} trains   tonight's trains (fareCalendar filled)
 * @param {Record<string, object>|null} previous  last night's trains file
 * @param {{ today: string, fetchTrain: (train: string, date: string) => Promise<object|null>,
 *           reads?: number, spacingMs?: number, sleep?: (ms: number) => Promise<void> }} opts
 */
export async function fillTimetableVariants(
  trains,
  previous,
  {
    today,
    fetchTrain,
    reads: budget = NJ_TIMETABLE_READS_PER_RUN,
    spacingMs = SPACING_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  },
) {
  const stats = { planned: 0, read: 0, kept: 0, carried: 0, mismatched: 0, failed: 0, capped: false, stopped: false };
  const { reads, carried } = planTimetableReads(trains, previous, { today });
  stats.planned = reads.length;
  for (const [key, kept] of carried) {
    trains[key].timetableVariants = { ...kept };
    stats.carried += Object.keys(kept).length;
  }
  let failures = 0;
  for (const [i, read] of reads.entries()) {
    if (stats.read >= budget) {
      stats.capped = true;
      break;
    }
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      stats.stopped = true;
      break;
    }
    if (i > 0 && spacingMs) await sleep(spacingMs);
    stats.read++;
    let answer = null;
    try {
      answer = await fetchTrain(read.train, read.night);
    } catch {
      answer = null;
    }
    if (!answer?.stations?.length) {
      failures++;
      stats.failed++;
      continue;
    }
    failures = 0;
    const got = runClock(answer);
    if (!got || got.night !== read.night || got.key !== read.clock) {
      stats.mismatched++;
      console.log(
        `[nj] ${read.train} ${read.night}: asked for the ${read.clock} timetable, ` +
          `answered ${got ? `${got.key} on ${got.night}` : "an unreadable run"} — not kept`,
      );
      continue;
    }
    trains[read.key].timetableVariants ??= {};
    trains[read.key].timetableVariants[read.clock] = {
      readAt: today,
      night: read.night,
      stations: compactStations(answer.stations),
    };
    stats.kept++;
  }
  for (const train of Object.values(trains)) {
    if (train.timetableVariants && !Object.keys(train.timetableVariants).length) {
      delete train.timetableVariants;
    }
  }
  return stats;
}
