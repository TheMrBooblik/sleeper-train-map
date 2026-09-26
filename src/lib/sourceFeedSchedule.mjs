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
    })),
    days: train.frequency || null,
    validFrom: null,
    validUntil: null,
    source: "source-feed",
  };
}
