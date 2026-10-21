// src/lib/sourceFeedSchedule.mjs
// The timetable for a synthetic row, read from the registry source that built it.
//
// A synthetic row (trafiklab_93, cfr_IR-N_1947, sncf_…) exists because an
// official feed carries a train Back-on-Track does not, so it has no trips in
// the Back-on-Track table — and the detail panel builds its cards from trips.
// It falls back to making trip-like cards from the row, but only for trains it
// can place in one of its hardcoded per-operator feeds (NightJet, 12306, ICN,
// Amtrak/VIA, European Sleeper…); anything else read "No Back on Track trip
// data for this selection", which is what Sweden's new Stockholm–Luleå train
// showed. The build now stamps `timetable_source` on every synthetic row — and
// on every Back-on-Track row an official feed corroborated, whose card
// otherwise listed only via names with no times between the endpoints — so the
// panel can ask that source for the train by its own label instead of learning
// an eleventh feed.
//
// Dependency-free so raw-node tests load it as the panel does.

/** A trip-like card's source, when its row was built by a registry source. */
export function sourceFeedIdForRoute(route) {
  const id = String(route?.timetable_source ?? "").trim();
  return id || null;
}

const asClock = (value) => {
  if (!value) return null;
  const s = String(value);
  // ISO ("2026-09-13T16:01:00Z" / "T16:01") or a bare "HH:MM".
  const iso = s.match(/T(\d{1,2}):(\d{2})/);
  const bare = iso ? null : s.trim().match(/^(\d{1,2}):(\d{2})/);
  const m = iso ?? bare;
  return m ? `${String(Number(m[1]) % 24).padStart(2, "0")}:${m[2]}` : null;
};

/**
 * The schedule for one direction of a synthetic row, in the shape the panel's
 * other feeds produce ({ tripId, stops: [{ name, arrival, departure }], days }),
 * or null when the source's file does not carry the train.
 *
 * Looked up by the row's own label only. The trains file is the one this row
 * was built from, so the label cannot belong to another operator's train — the
 * bare-number collision the per-operator feeds each have to guard against.
 *
 * @param {Record<string, object>|null|undefined} trains the source's trains dict
 * @param {{trip_short_name?: string}} trip
 */
export function sourceFeedSchedule(trains, trip) {
  const label = String(trip?.trip_short_name ?? "").trim();
  if (!trains || !label) return null;
  const train = trains[label];
  const stations = Array.isArray(train?.stations) ? train.stations : [];
  if (stations.length < 2) return null;
  return {
    tripId: label,
    stops: stations.map((s, i) => ({
      stopId: s.code || s.name || String(i),
      sequence: i + 1,
      name: s.name || "Station",
      arrival: asClock(s.arrival),
      departure: asClock(s.departure),
      ...(Number.isInteger(s.arrivalDay) ? { arrivalDay: s.arrivalDay } : {}),
      ...(Number.isInteger(s.departureDay) ? { departureDay: s.departureDay } : {}),
    })),
    days: train.frequency || null,
    // The source's own journey time where it states one (it can exceed a day).
    durationMinutes: Number.isInteger(train.durationMinutes) && train.durationMinutes > 0 ? train.durationMinutes : null,
    validFrom: null,
    validUntil: null,
    source: "source-feed",
    changes: groupUpcomingChanges(train.deviations),
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nextIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * The nights a source says the train does not run its usual timetable
 * (engineering works, a seasonal extension), as runs of consecutive nights on
 * the same routing — so a fortnight's diversion reads as one block listing
 * what it skips once, with each night's own clock beneath it. The clock is
 * per night because works timetables are: SJ 93 on its inland diversion
 * reaches Stockholm at 12:13, 13:42, 14:13 or 14:26 depending on the night.
 *
 * `deviations` is what the adapter wrote for the next fortnight (see
 * `upcomingDeviations` in trafiklab-gtfs.mjs). The file is rewritten nightly
 * but a page can be read days later, so nights before `today` are dropped here
 * rather than trusted to be gone.
 *
 * @param {Array<{date: string, from: string, to: string, departure: string|null,
 *   arrival: string|null, stops: number, skipped?: string[], added?: string[]}>} deviations
 * @param {{today?: string}} [opts] "YYYY-MM-DD", defaults to the local date
 * @returns {Array<{dates: string[], nights: Array<{date: string, departure: string|null,
 *   arrival: string|null}>, from: string, to: string, stops: number,
 *   skipped: string[], added: string[]}>}
 */
export function groupUpcomingChanges(deviations, { today } = {}) {
  if (!Array.isArray(deviations) || !deviations.length) return [];
  const floor = ISO_DATE_RE.test(String(today ?? ""))
    ? today
    : (() => {
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        return `${now.getFullYear()}-${mm}-${dd}`;
      })();
  const routing = (d) =>
    [d.from, d.to, d.stops, (d.skipped || []).join("|"), (d.added || []).join("|")].join("~");
  const groups = [];
  const sorted = deviations
    .filter((d) => ISO_DATE_RE.test(String(d?.date ?? "")) && d.date >= floor)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const d of sorted) {
    const night = { date: d.date, departure: asClock(d.departure), arrival: asClock(d.arrival) };
    const last = groups[groups.length - 1];
    if (
      last &&
      last.routing === routing(d) &&
      nextIsoDate(last.dates[last.dates.length - 1]) === d.date
    ) {
      last.dates.push(d.date);
      last.nights.push(night);
      continue;
    }
    groups.push({
      routing: routing(d),
      dates: [d.date],
      nights: [night],
      from: d.from,
      to: d.to,
      stops: d.stops,
      skipped: d.skipped || [],
      added: d.added || [],
    });
  }
  return groups.map(({ routing: _r, ...g }) => g);
}
