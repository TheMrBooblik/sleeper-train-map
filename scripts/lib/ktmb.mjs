// scripts/lib/ktmb.mjs
// KTM Berhad (Malaysia) night trains: the pure half of scripts/adapters/ktmb.mjs.
//
// Two official sources, each read for what it states:
//
//   - data.gov.my's GTFS Static for KTMB (api.data.gov.my/gtfs-static/ktmb,
//     the government's open transport API; it redirects to the zip on S3):
//     every Intercity and ETS trip with its full stop list, real times and
//     stop positions. No shapes, no fares, no train names — trip_id is the
//     train number ("26", "27"), route_id the service ("ERT").
//   - KITS, KTMB's own ticket shop (online.ktmb.com.my): per train and date,
//     the coaches with the fare of every place in them, from the search a
//     traveller makes before logging in (scripts/lib/ktmb-kits.mjs).
//
// What counts as a night train is the allowlist's route (`routes`) plus the
// clock: a trip that leaves in the evening and runs past midnight for at
// least `minMinutes`. The Ekspres Rakyat Timuran (JB Sentral – Tumpat) is the
// one KTM train still carrying sleeping berths; the overnight ETS runs
// (KL Sentral – Padang Besar / Hat Yai) are seated and stay out, and so does
// the ERT route's midday Merapoh – JB Sentral working, which the feed files
// under the same route.
//
// Dependency-free (bar the polyline encoder) so tests/verify-ktmb.mjs can run
// it against the answers the probe captured.

import polyline from "@mapbox/polyline";
import { buildRailGraph, routeThroughStops } from "./rail-graph.mjs";

/** "10:05:00" / "25:56:00" → minutes after the first day's midnight. */
export function gtfsMinutes(t) {
  const m = /^\s*(\d{1,3}):(\d{2})/.exec(String(t ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after the first midnight → "HH:MM" on a 24-hour clock, and the day offset. */
export function clockOf(minutes) {
  if (!Number.isFinite(minutes)) return { time: null, day: null };
  const day = Math.floor(minutes / 1440);
  const m = minutes - day * 1440;
  return { time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, day };
}

// Words that keep their case in a station name: "JB SENTRAL" is "JB Sentral",
// not "Jb Sentral"; "CIQ" is the checkpoint.
const KEEP_UPPER = new Set(["JB", "KL", "CIQ", "KLIA", "ETS", "ERL"]);

/** "KUALA LIPIS" → "Kuala Lipis", "JB SENTRAL" → "JB Sentral"; `stationNames` overrides. */
export function makeStationNamer(stationNames = {}) {
  const table = new Map(
    Object.entries(stationNames)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k.trim().toUpperCase(), v]),
  );
  return (raw) => {
    const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
    const named = table.get(clean.toUpperCase());
    if (named) return named;
    return clean
      .split(" ")
      .map((w) =>
        KEEP_UPPER.has(w.toUpperCase())
          ? w.toUpperCase()
          : w
              .toLowerCase()
              .replace(/(^|[-/.(])([a-z])/g, (_, p, c) => p + c.toUpperCase()),
      )
      .join(" ");
  };
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The days a service runs, as the row's service string: "Daily", or the
 * weekdays ("Mon, Wed, Fri"). Read from calendar.txt's weekday columns only:
 * its start/end dates are the feed's own validity window (data.gov.my
 * republishes it with a later end), not a season, and a row carrying them
 * would stop drawing the day the window closes.
 */
export function serviceDays(serviceIds, calendar = []) {
  const ids = new Set(serviceIds);
  const on = new Set();
  for (const c of calendar) {
    if (!ids.has(c.service_id)) continue;
    WEEKDAYS.forEach((d, i) => {
      if (String(c[d]) === "1") on.add(i);
    });
  }
  if (!on.size) return null;
  if (on.size === 7) return "Daily";
  return [...on].sort((a, b) => a - b).map((i) => SHORT[i]).join(", ");
}

/** The latest end_date among these services (YYYY-MM-DD), to warn when the feed has lapsed. */
export function serviceEnd(serviceIds, calendar = []) {
  const ids = new Set(serviceIds);
  const ends = calendar.filter((c) => ids.has(c.service_id)).map((c) => String(c.end_date ?? "")).filter((d) => /^\d{8}$/.test(d));
  if (!ends.length) return null;
  const max = ends.sort().at(-1);
  return `${max.slice(0, 4)}-${max.slice(4, 6)}-${max.slice(6, 8)}`;
}

/**
 * The night trains in a parsed feed: trips on an allowlisted route that leave
 * at or after `minDepartureHour` and run past midnight for at least
 * `minMinutes`. One train per trip_id (the train number); a number the feed
 * files twice (two service periods) keeps the trip with the most stops.
 *
 * @param {{ routes: object[], trips: object[], stopTimesByTrip: Map, stopsById: Map, calendar: object[] }} feed
 */
export function nightTrips(feed, config, namer = makeStationNamer(config.stationNames)) {
  const routes = new Set(config.routes ?? []);
  const minMinutes = config.minMinutes ?? 300;
  const minDep = (config.minDepartureHour ?? 17) * 60;
  const byNumber = new Map();
  const skipped = [];
  for (const trip of feed.trips) {
    if (!routes.has(trip.route_id)) continue;
    const st = [...(feed.stopTimesByTrip.get(trip.trip_id) ?? [])].sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (st.length < 2) continue;
    const dep = gtfsMinutes(st[0].departure_time || st[0].arrival_time);
    const arr = gtfsMinutes(st.at(-1).arrival_time || st.at(-1).departure_time);
    if (dep == null || arr == null) continue;
    const length = arr >= dep ? arr - dep : arr + 1440 - dep;
    const crosses = arr >= 1440 || arr < dep;
    if (!(crosses && length >= minMinutes && dep >= minDep)) {
      skipped.push(`${trip.trip_id} (${clockOf(dep).time} → ${clockOf(arr % 1440).time}, ${Math.round(length / 6) / 10} h)`);
      continue;
    }
    const number = String(trip.trip_id).trim();
    const stops = [];
    for (const s of st) {
      const stop = feed.stopsById.get(s.stop_id) ?? {};
      const lat = Number(stop.stop_lat ?? stop.lat);
      const lon = Number(stop.stop_lon ?? stop.lon);
      let a = gtfsMinutes(s.arrival_time);
      let d = gtfsMinutes(s.departure_time);
      // A feed writing "next day" as an earlier clock rather than 24+:
      // lift it past the previous stop's time.
      const last = stops.length ? stops.at(-1).depMin ?? stops.at(-1).arrMin : dep;
      while (a != null && a < last) a += 1440;
      while (d != null && a != null && d < a) d += 1440;
      stops.push({ id: s.stop_id, name: namer(stop.stop_name ?? stop.name ?? s.stop_id), lat, lon, arrMin: a, depMin: d });
    }
    const prev = byNumber.get(number);
    if (prev && prev.stops.length >= stops.length) continue;
    byNumber.set(number, {
      number,
      routeId: trip.route_id,
      directionId: trip.direction_id ?? null,
      serviceId: trip.service_id,
      stops,
      durationMinutes: stops.at(-1).arrMin - stops[0].depMin,
    });
  }
  return { trains: byNumber, skipped };
}

/** Outbound/return pairs in file order: the lower number first, then its partner (n / n+1). */
export function pairOrder(numbers) {
  const set = new Set(numbers);
  const out = [];
  const seen = new Set();
  for (const n of [...numbers].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
    if (seen.has(n)) continue;
    out.push(n);
    seen.add(n);
    const partner = Number(n) % 2 === 0 ? String(Number(n) + 1) : String(Number(n) - 1);
    if (set.has(partner) && !seen.has(partner)) {
      out.push(partner);
      seen.add(partner);
    }
  }
  return out;
}

/**
 * How long a train the feed stopped carrying is kept from last night's file:
 * data.gov.my is the only timetable, so an outage of a few nights should not
 * blank Malaysia, and a month without one is no longer a timetable.
 */
export const CARRY_MAX_DAYS = 30;

/** { classKey: amount } → the fare record a trains file carries, or null for no berth. */
export function fareRecord(classes, { sampledAt, travelDate, currency = "MYR" }) {
  const entries = Object.entries(classes ?? {}).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return {
    fromPrice: entries[0][1],
    currency,
    seatClass: entries[0][0],
    classes: Object.fromEntries(entries),
    sampledAt,
    travelDate,
  };
}

/**
 * The trains file entries. `feedTrains` is nightTrips' answer for tonight (or
 * null when the feed could not be read), `fares` a Map number → { classKey:
 * amount } from KITS, `previous` last night's trains (stops, times and fares
 * are carried from it where tonight read none).
 */
export function buildKtmbTrains({ config, feedTrains, fares = new Map(), osmTrack = null, previous = {}, today, travelDate, log = () => {} }) {
  const operator = config.operator ?? {};
  const serviceName = config.serviceNames ?? {};
  const graphs = osmTrack?.length ? [["osm", buildRailGraph(osmTrack, { joinMeters: 30 })]] : [];
  const memo = new Map();
  const prevByNumber = new Map(Object.values(previous).map((t) => [String(t.trainNo ?? ""), t]));
  const fresh = (t) => {
    const at = Date.parse(`${t?.timetable?.checkedAt ?? ""}T00:00:00Z`);
    return Number.isFinite(at) && (Date.parse(`${today}T00:00:00Z`) - at) / 86_400_000 <= CARRY_MAX_DAYS;
  };
  const numbers = feedTrains ? [...feedTrains.keys()] : [...prevByNumber.keys()].filter((n) => n && fresh(prevByNumber.get(n)));
  const trains = {};
  for (const number of pairOrder(numbers)) {
    const live = feedTrains?.get(number) ?? null;
    const prev = prevByNumber.get(number) ?? null;
    const price = fares.get(number);
    const fare = price ? fareRecord(price, { sampledAt: today, travelDate }) : prev?.fare ?? null;
    if (!live) {
      if (!prev) continue;
      trains[prev.lineName] = { ...prev, ...(fare ? { fare } : {}), timetable: { source: "previous", checkedAt: prev.timetable?.checkedAt ?? null } };
      continue;
    }
    const missing = live.stops.filter((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lon));
    if (missing.length) {
      log(`${number}: no position for ${missing.map((s) => s.name).join(", ")} — left out`);
      continue;
    }
    const base = live.stops[0].depMin;
    const stations = live.stops.map((s, i) => {
      const first = i === 0;
      const last = i === live.stops.length - 1;
      const a = first ? { time: null, day: null } : clockOf(s.arrMin - Math.floor(base / 1440) * 1440);
      const d = last ? { time: null, day: null } : clockOf(s.depMin - Math.floor(base / 1440) * 1440);
      return {
        name: s.name,
        location: { latitude: s.lat, longitude: s.lon },
        arrival: a.time,
        departure: d.time,
        arrivalDay: a.day,
        departureDay: d.day,
        pickup: true,
        dropoff: true,
      };
    });

    // The line: every gap between two stops routed along OpenStreetMap's
    // track (the feed ships no shapes), straight only where none is found.
    let encoded;
    let geometry;
    if (graphs.length) {
      const routed = routeThroughStops(live.stops.map((s) => [s.lat, s.lon]), graphs, () => null, memo);
      geometry = routed.sources.reduce((acc, src) => ({ ...acc, [src]: (acc[src] ?? 0) + 1 }), {});
      encoded = polyline.encode(routed.path);
    } else {
      geometry = { chord: live.stops.length - 1 };
      encoded = polyline.encode(live.stops.map((s) => [s.lat, s.lon]));
    }
    // A night without OSM must not make a line worse than last night's.
    const sameStops = prev && prev.stations?.map((s) => s.name).join(">") === stations.map((s) => s.name).join(">");
    if (sameStops && (geometry.chord ?? 0) > (prev.geometry?.chord ?? Infinity) && prev.polyline) {
      encoded = prev.polyline;
      geometry = { ...prev.geometry, carried: true };
    }
    if (geometry.chord) log(`${number}: ${geometry.chord} of ${live.stops.length - 1} gap(s) drawn straight — no track found between those stops`);

    const service = serviceName[live.routeId] ?? live.routeId;
    const lineName = `${config.lineNamePrefix?.[live.routeId] ?? live.routeId} ${number}`;
    trains[lineName] = {
      lineName,
      trainNo: number,
      service,
      operator: operator.name ?? "KTM Berhad",
      agency_id: operator.agencyId ?? "KTMB",
      frequency: live.frequency ?? null,
      durationMinutes: live.durationMinutes,
      nights: Math.floor((live.stops.at(-1).arrMin) / 1440) - Math.floor(base / 1440),
      polyline: encoded,
      geometry,
      stations,
      ...(fare ? { fare } : {}),
      timetable: { source: "official", checkedAt: today, ...(live.validUntil ? { validUntil: live.validUntil } : {}) },
    };
  }
  return trains;
}
