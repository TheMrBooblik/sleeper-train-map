// scripts/lib/srt.mjs
// State Railway of Thailand night trains: the pure half of scripts/adapters/srt.mjs.
//
// Two official sources meet here, and each is read only for what it states:
//
//   - Namtang, the Ministry of Transport's national GTFS: station positions,
//     the full stop list of most long-distance trains, and their track. Its
//     long-distance stop times are placeholders — a 13-hour Bangkok–Chiang Mai
//     trip is filed as 00:00 → 00:07, one minute a stop — so no time from it is
//     ever used (`isPlaceholderTiming` is how that is recognised).
//   - D-Ticket, SRT's own booking site: per corridor and date, the trains with
//     their departure and arrival times (booking/booking/getTrip), and per
//     train the coaches with each berth's fare (booking/booking/getTrainCoach).
//     Both are what the site's own page asks before anyone logs in.
//
// Dependency-free (bar the polyline encoder) so tests/verify-srt.mjs can run it
// against the answers the probe captured.

import polyline from "@mapbox/polyline";
import { haversineKm, trackPathFromSiblings } from "./sibling-path.mjs";
import { buildRailGraph, routeThroughStops } from "./rail-graph.mjs";

/** "SRT เชียงใหม่;SRT Chiang Mai\t" → { th: "เชียงใหม่", en: "Chiang Mai" } */
export function bilingualName(raw) {
  const parts = String(raw ?? "").split(";").map((p) => p.replace(/\s+/g, " ").trim());
  const strip = (s) => s.replace(/^SRT\s+/, "").trim();
  const en = strip(parts[parts.length - 1] ?? "");
  const th = parts.length > 1 ? strip(parts[0]) : "";
  return { th, en };
}

/** One spelling per station, from either source's English name. */
export function makeStationNamer(stationNames = {}) {
  const table = new Map(
    Object.entries(stationNames)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k.trim().toLowerCase(), v]),
  );
  return (name) => {
    const clean = String(name ?? "").replace(/\s+/g, " ").trim();
    return table.get(clean.toLowerCase()) ?? clean;
  };
}

/** The train number a Namtang route stands for: "9 ด่วนพิเศษ" → "9", "102" → "102". */
export function routeTrainNumber(shortName) {
  const m = /^\s*(\d{1,4})\b/.exec(String(shortName ?? ""));
  return m ? String(Number(m[1])) : null;
}

const toMinutes = (hhmmss) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmmss ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Whether a trip's stop times are Namtang's placeholders rather than a
 * timetable: it starts within the first minutes after midnight and spends
 * about a minute per stop — no long-distance train does either, let alone both.
 */
export function isPlaceholderTiming(stopTimes) {
  const times = stopTimes.map((s) => toMinutes(s.departure_time || s.arrival_time)).filter((t) => t != null);
  if (times.length < 2) return true;
  const span = times[times.length - 1] - times[0];
  return times[0] <= 2 && span <= stopTimes.length * 2;
}

/**
 * Per train number, the longest Namtang trip filed under it: its stops (with
 * positions) and its track. Short metropolitan stubs (the same number's
 * Bangkok–Rangsit leg, which Namtang also carries) lose to the full trip.
 *
 * @param {{ routes: object[], trips: object[], stopTimesByTrip: Map, stopsById: Map, shapesById: Map }} feed
 */
export function namtangTrains(feed, namer) {
  const routeNumber = new Map();
  for (const r of feed.routes) {
    if (r.agency_id !== "SRT") continue;
    const n = routeTrainNumber(r.route_short_name);
    if (n) routeNumber.set(r.route_id, n);
  }
  const best = new Map();
  for (const t of feed.trips) {
    const number = routeNumber.get(t.route_id);
    if (!number) continue;
    const times = (feed.stopTimesByTrip.get(t.trip_id) ?? [])
      .slice()
      .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (times.length < 2) continue;
    const stops = [];
    for (const st of times) {
      const stop = feed.stopsById.get(st.stop_id);
      if (!stop) continue;
      const name = namer(bilingualName(stop.stop_name).en);
      if (stops.length && stops[stops.length - 1].name === name) continue;
      stops.push({ name, nameTh: bilingualName(stop.stop_name).th, lat: Number(stop.stop_lat), lon: Number(stop.stop_lon) });
    }
    const prev = best.get(number);
    if (prev && prev.stops.length >= stops.length) continue;
    best.set(number, {
      number,
      tripId: t.trip_id,
      stops,
      shape: feed.shapesById.get(t.shape_id) ?? null,
      placeholderTimes: isPlaceholderTiming(times),
    });
  }
  return best;
}

/** Thai "trainTypeNameEn" → the name the map prints before the number. */
export function serviceName(typeEn) {
  const t = String(typeEn ?? "").toUpperCase();
  if (t.startsWith("SPECIAL EXPRESS")) return "Special Express";
  if (t.startsWith("EXPRESS")) return "Express";
  if (t.startsWith("RAPID")) return "Rapid";
  if (t.startsWith("ORDINARY")) return "Ordinary";
  return t ? t.charAt(0) + t.slice(1).toLowerCase() : "Train";
}

const isoDay = (s) => String(s ?? "").slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${isoDay(b)}T00:00:00Z`) - Date.parse(`${isoDay(a)}T00:00:00Z`)) / 86_400_000);

/**
 * D-Ticket's getTrip answer → trips. Strict: an answer that is not
 * S_SUCCESS with a list is an error (null), never "no trains".
 */
export function parseTrips(answer) {
  if (!answer || answer.errorCode !== "S_SUCCESS" || !Array.isArray(answer.data)) return null;
  return answer.data
    .map((t) => ({
      tripId: String(t.tripId ?? ""),
      trainNo: String(Number(t.trainNo)),
      typeEn: t.trainTypeNameEn ?? t.trainTypeCodeEn ?? "",
      departure: /^\d{2}:\d{2}$/.test(t.departureTime) ? t.departureTime : null,
      arrival: /^\d{2}:\d{2}$/.test(t.arrivalTime) ? t.arrivalTime : null,
      nights: dayDiff(t.departureDate, t.arrivalDate),
    }))
    .filter((t) => t.tripId && t.trainNo !== "NaN" && t.departure && t.arrival);
}

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minutes a trip takes, across the nights it spans. */
export const tripMinutes = (trip) => trip.nights * 1440 + toMin(trip.arrival) - toMin(trip.departure);

/**
 * A coach list's berths → { classKey: fare } (the cheapest per class), from
 * D-Ticket's getTrainCoach. Seats are left out, and so are the coaches kept
 * for women and children or for passengers with disabilities: they sell the
 * same berth at the same fare, and a reader of "from ฿938" should be able to
 * buy it whoever they are. Returns null for an unreadable answer.
 */
export function berthFares(answer, classMap) {
  if (!answer || answer.errorCode !== "S_SUCCESS" || !Array.isArray(answer.data?.results)) return null;
  const classes = {};
  for (const coach of answer.data.results) {
    const desc = String(coach.coachDesc ?? "");
    if (String(coach.coachSeatType) !== "1" && !/sleep/i.test(coach.coachSeatTypeEn ?? "")) continue;
    if (/สตรี|ผู้พิการ|women|lady|disab/i.test(desc)) continue;
    const fan = String(coach.coachAirType) === "2" || /fan/i.test(coach.coachAirTypeEn ?? "");
    const cls = `${coach.coachClass}${fan ? "fan" : ""}`;
    for (const seat of coach.coachSeats ?? []) {
      const key = classMap[`${cls}:${seat.seatTypNameEn}`];
      const amount = Number(seat.seatFeeAmt);
      if (!key || !Number.isFinite(amount) || amount <= 0) continue;
      if (classes[key] == null || amount < classes[key]) classes[key] = amount;
    }
  }
  return classes;
}

/** { classes } → the fare record a trains file carries, or null for no berth. */
export function fareRecord(classes, { sampledAt, travelDate }) {
  const entries = Object.entries(classes ?? {}).filter(([, v]) => Number.isFinite(v));
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return {
    fromPrice: entries[0][1],
    currency: "THB",
    seatClass: entries[0][0],
    classes: Object.fromEntries(entries),
    sampledAt,
    travelDate,
  };
}

/**
 * The trains each corridor's answer contributes. A train is kept when it runs
 * overnight and sells a berth. One found on several corridors in the same
 * direction is filed under the one it rides longest — the one ending at its
 * own terminus, since every corridor shares the origin.
 *
 * @param {{ from: string, to: string, trips: object[], faresByTrip: Map }[]} answers
 */
export function pickCorridorTrains(answers) {
  const byNumber = new Map();
  for (const a of answers) {
    for (const trip of a.trips ?? []) {
      if (trip.nights < 1) continue;
      const fare = a.faresByTrip?.get(trip.tripId);
      if (!fare || !Object.keys(fare).length) continue;
      const minutes = tripMinutes(trip);
      const prev = byNumber.get(trip.trainNo);
      if (prev && prev.minutes >= minutes) continue;
      byNumber.set(trip.trainNo, { ...trip, from: a.from, to: a.to, minutes, classes: fare });
    }
  }
  return byNumber;
}

/** Outbound/return pairs in file order: odd n with n+1 unless `pairs` says otherwise. */
export function pairOrder(numbers, pairs = {}) {
  const set = new Set(numbers);
  const explicit = Object.fromEntries(Object.entries(pairs).filter(([k]) => !k.startsWith("_")));
  const partnerOf = (n) => explicit[n] ?? (Number(n) % 2 === 1 ? String(Number(n) + 1) : null);
  // A return numbered below its outbound (109's is 102) waits for it.
  const returnOf = new Map(Object.entries(explicit).map(([out, ret]) => [ret, out]));
  const out = [];
  const seen = new Set();
  for (const n of [...numbers].sort((a, b) => Number(a) - Number(b))) {
    if (seen.has(n)) continue;
    if (returnOf.has(n) && set.has(returnOf.get(n))) continue;
    const p = partnerOf(n);
    out.push(n);
    seen.add(n);
    if (p && set.has(p) && !seen.has(p)) {
      out.push(p);
      seen.add(p);
    }
  }
  return out;
}

const KM_SAME_STATION = 3;

/**
 * How long a train D-Ticket stopped confirming is carried from last night's
 * file: D-Ticket answers some runner addresses and not others, so a few
 * nights in a row without an answer is expected, but a timetable nobody has
 * confirmed for a month is no longer one to publish (fares.mjs keeps the same
 * 30 days for a fare).
 */
export const CARRY_MAX_DAYS = 30;

/**
 * Build the trains file entries. `found` is pickCorridorTrains' answer for
 * tonight (or null when D-Ticket was unreachable), `previous` last night's
 * trains file (times and fares are carried from it when tonight read none).
 */
export function buildSrtTrains({
  config,
  found,
  namtang,
  positions,
  previous = {},
  today,
  travelDate,
  osmTrack = null,
  log = () => {},
}) {
  const namer = makeStationNamer(config.stationNames);
  const operator = config.operator ?? {};
  const donors = [...namtang.values()].map((t) => t.shape).filter((s) => Array.isArray(s) && s.length >= 3);
  // Where the line comes from, best first: OpenStreetMap's railway ways (a
  // real network, junctions and branches included), then Namtang's shapes
  // joined where they overlap, then the nearest SRT shape that covers a gap.
  const graphs = [];
  if (osmTrack?.length) graphs.push(["osm", buildRailGraph(osmTrack, { joinMeters: 30 })]);
  graphs.push(["namtang", buildRailGraph(donors, { joinMeters: 150 })]);
  const memo = new Map();
  const siblingGap = (a, b) => {
    const { path, filled } = trackPathFromSiblings([a, b], donors);
    return filled ? path : null;
  };
  const prevByNumber = new Map(Object.values(previous).map((t) => [String(t.trainNo ?? ""), t]));

  const fresh = (t) => {
    const at = Date.parse(`${t?.timetable?.checkedAt ?? ""}T00:00:00Z`);
    return Number.isFinite(at) && (Date.parse(`${today}T00:00:00Z`) - at) / 86_400_000 <= CARRY_MAX_DAYS;
  };
  for (const [n, t] of [...prevByNumber]) {
    if (!fresh(t)) {
      log(`${n}: last confirmed ${t?.timetable?.checkedAt ?? "never"}, over ${CARRY_MAX_DAYS} days ago — no longer carried`);
      prevByNumber.delete(n);
    }
  }
  const numbers = found ? [...found.keys()] : [...prevByNumber.keys()].filter(Boolean);
  const trains = {};
  for (const number of pairOrder(numbers, config.pairs)) {
    const live = found?.get(number) ?? null;
    const prev = prevByNumber.get(number) ?? null;
    if (!live && !prev) continue;
    const from = namer(live?.from ?? prev.stations[0].name);
    const to = namer(live?.to ?? prev.stations[prev.stations.length - 1].name);

    // Stops: Namtang's full trip when it runs between the same two stations,
    // else just the two ends — a stop list nobody published is not invented.
    const nt = namtang.get(number);
    const ntEnds = nt && nt.stops.length >= 2 ? [nt.stops[0].name, nt.stops[nt.stops.length - 1].name] : null;
    const stopsFromFeed = ntEnds && ntEnds[0] === from && ntEnds[1] === to;
    const where = (name) => positions.get(name) ?? null;
    const stops = stopsFromFeed
      ? nt.stops.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon }))
      : [from, to].map((name) => ({ name, ...(where(name) ?? { lat: null, lon: null }) }));
    if (stops.some((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lon))) {
      log(`${number}: no position for ${stops.filter((s) => !Number.isFinite(s.lat)).map((s) => s.name).join(", ")} — left out`);
      continue;
    }
    if (!stopsFromFeed) log(`${number}: ${from} → ${to} — Namtang has no full trip for it, endpoints only`);

    const departure = live?.departure ?? prev?.stations?.[0]?.departure ?? null;
    const arrival = live?.arrival ?? prev?.stations?.[prev.stations.length - 1]?.arrival ?? null;
    const stations = stops.map((s, i) => ({
      name: s.name,
      location: { latitude: s.lat, longitude: s.lon },
      arrival: i === stops.length - 1 ? arrival : null,
      departure: i === 0 ? departure : null,
      pickup: true,
      dropoff: true,
    }));

    // Track: every gap between two stops routed along real track, so a
    // shape Namtang cut short (train 31's ends at Chumphon) and a train it
    // carries only as two ends (83 to Trang, off the main line at Thung Song)
    // both draw along the rails rather than across the country.
    const routed = routeThroughStops(stops.map((s) => [s.lat, s.lon]), graphs, siblingGap, memo);
    const geometry = routed.sources.reduce((acc, src) => ({ ...acc, [src]: (acc[src] ?? 0) + 1 }), {});
    let encoded = polyline.encode(routed.path);
    // A night without OSM must not make a line worse than last night's.
    const prevChords = prev?.geometry?.chord ?? Infinity;
    const sameStops = prev && prev.stations?.map((s) => s.name).join(">") === stops.map((s) => s.name).join(">");
    if (sameStops && (geometry.chord ?? 0) > prevChords && prev.polyline) {
      encoded = prev.polyline;
      Object.assign(geometry, prev.geometry, { carried: true });
    }
    if (geometry.chord) log(`${number}: ${geometry.chord} of ${routed.sources.length} gap(s) drawn straight — no track found between those stops`);

    const fare = live
      ? fareRecord(live.classes, { sampledAt: today, travelDate })
      : prev?.fare ?? null;
    const type = live ? serviceName(live.typeEn) : prev?.service ?? "Train";
    const lineName = `${type} ${number}`;
    trains[lineName] = {
      lineName,
      trainNo: number,
      service: type,
      operator: operator.name ?? "State Railway of Thailand",
      agency_id: operator.agencyId ?? "SRT",
      frequency: config.frequency ?? null,
      polyline: encoded,
      geometry,
      stations,
      ...(fare ? { fare } : {}),
      timetable: live
        ? { source: "official", checkedAt: today, travelDate }
        : { source: "previous", checkedAt: prev?.timetable?.checkedAt ?? null },
    };
  }
  return trains;
}

/** Positions by station name: Namtang's stops first, then the config's own. */
export function stationPositions(namtang, config) {
  const namer = makeStationNamer(config.stationNames);
  const out = new Map();
  for (const t of namtang.values()) {
    for (const s of t.stops) if (!out.has(s.name)) out.set(s.name, { lat: s.lat, lon: s.lon });
  }
  for (const [name, c] of Object.entries(config.coordinates ?? {})) {
    if (name.startsWith("_")) continue;
    const key = namer(name);
    if (!out.has(key)) out.set(key, { lat: c.lat, lon: c.lon });
  }
  return out;
}

/** Whether two positions are one station (for tests and sanity checks). */
export const sameStation = (a, b) => haversineKm([a.lat, a.lon], [b.lat, b.lon]) <= KM_SAME_STATION;
