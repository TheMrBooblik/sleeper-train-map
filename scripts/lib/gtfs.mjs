// scripts/lib/gtfs.mjs
// Generic GTFS → trains-dict builder, shared by the registry's `gtfs-sleeper`
// adapter (Amtrak, VIA Rail). Operator GTFS feeds carry everything we need —
// stop coordinates, route shapes and service calendars — so a North American
// sleeper route becomes a synthetic map route with no manual coordinate entry.
//
// The heavy work is split so it stays testable offline:
//   - downloadGtfs(url, destDir)  → network (used by the adapter only)
//   - loadGtfsDir(dir)            → parses the .txt tables into memory (pure)
//   - buildSleeperTrains({...})   → filters to an allowlist, builds the trains
//                                   dict in the standard shape (pure)
//
// CSV parsing / download / unzip mirror scripts/parse-pkp-gtfs.js; the service
// calendar is rendered with the canonical parser in src/pages/api/lib/calendar.mjs.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execSync } from "node:child_process";
import polyline from "@mapbox/polyline";
import {
  parseGtfsCalendar,
  renderCalendar,
} from "../../src/pages/api/lib/calendar.mjs";

// ─── CSV / download / unzip (mirrors parse-pkp-gtfs.js) ──────────────────────

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

export function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    const out = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? "";
    });
    return out;
  });
}

export function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (!loc) {
            reject(new Error("Redirect without location"));
            return;
          }
          res.resume();
          downloadFile(loc, destPath).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => reject(err));
      });
  });
}

// Download + unzip a GTFS feed into destDir (returns destDir). Requires `unzip`
// on PATH, exactly like the PKP/RegioJet parsers.
export async function downloadGtfs(url, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, "feed.zip");
  await downloadFile(url, zipPath);
  execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  return destDir;
}

// ─── Parse a GTFS directory into in-memory tables ────────────────────────────

const toNum = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the GTFS .txt tables we need into lookup structures.
 * @param {string} dir directory containing the unzipped feed
 */
export function loadGtfsDir(dir) {
  const routesById = new Map();
  for (const r of readCsv(path.join(dir, "routes.txt"))) {
    if (r.route_id) routesById.set(r.route_id, r);
  }

  const stopsById = new Map();
  for (const s of readCsv(path.join(dir, "stops.txt"))) {
    if (s.stop_id) {
      stopsById.set(s.stop_id, {
        name: (s.stop_name || s.stop_id).trim(),
        lat: toNum(s.stop_lat),
        lon: toNum(s.stop_lon),
        parent: s.parent_station || "",
      });
    }
  }

  // shape_id → [{ seq, lat, lon }] (sorted by sequence)
  const shapePoints = new Map();
  for (const row of readCsv(path.join(dir, "shapes.txt"))) {
    const id = row.shape_id;
    if (!id) continue;
    const lat = toNum(row.shape_pt_lat);
    const lon = toNum(row.shape_pt_lon);
    if (lat === null || lon === null) continue;
    if (!shapePoints.has(id)) shapePoints.set(id, []);
    shapePoints.get(id).push({
      seq: Number.parseInt(row.shape_pt_sequence || "0", 10),
      lat,
      lon,
    });
  }
  for (const pts of shapePoints.values()) pts.sort((a, b) => a.seq - b.seq);

  const trips = readCsv(path.join(dir, "trips.txt"));

  // trip_id → [{ seq, stop_id, arrival, departure }] (sorted by sequence)
  const tripIds = new Set(trips.map((t) => t.trip_id));
  const stopTimesByTrip = new Map();
  for (const row of readCsv(path.join(dir, "stop_times.txt"))) {
    if (!tripIds.has(row.trip_id)) continue;
    if (!stopTimesByTrip.has(row.trip_id)) stopTimesByTrip.set(row.trip_id, []);
    stopTimesByTrip.get(row.trip_id).push({
      seq: Number.parseInt(row.stop_sequence || "0", 10),
      stop_id: row.stop_id,
      arrival: row.arrival_time,
      departure: row.departure_time,
    });
  }
  for (const sts of stopTimesByTrip.values()) sts.sort((a, b) => a.seq - b.seq);

  // service_id → calendar.txt row (weekly pattern + date window)
  const calendarById = new Map();
  for (const row of readCsv(path.join(dir, "calendar.txt"))) {
    if (row.service_id) calendarById.set(row.service_id, row);
  }

  // service_id → ["YYYYMMDD"] of added dates (exception_type 1), for feeds that
  // ship only calendar_dates.txt.
  const addedDatesByService = new Map();
  for (const row of readCsv(path.join(dir, "calendar_dates.txt"))) {
    if (row.exception_type !== "1") continue;
    if (!addedDatesByService.has(row.service_id)) {
      addedDatesByService.set(row.service_id, []);
    }
    addedDatesByService.get(row.service_id).push(row.date);
  }

  return {
    routesById,
    stopsById,
    shapePoints,
    trips,
    stopTimesByTrip,
    calendarById,
    addedDatesByService,
  };
}

// ─── Service calendar → display string ───────────────────────────────────────

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Summarise calendar_dates-only services into a "Daily"/"Mon, Wed, Fri" string,
// mirroring parse-pkp-gtfs's summariseCalendar (the canonical renderer in
// calendar.mjs handles calendar.txt feeds).
function summariseAddedDates(dates) {
  if (!dates || dates.length === 0) return null;
  const sorted = [...dates].sort();
  const weekdays = new Set();
  for (const d of sorted) {
    const dt = new Date(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
    );
    weekdays.add(dt.getDay());
  }
  if (weekdays.size === 7) return "Daily";
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order
    .filter((d) => weekdays.has(d))
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");
}

// Resolve a trip's service to a human "when does it run" string.
function serviceDisplay(serviceId, gtfs) {
  const calRow = gtfs.calendarById.get(serviceId);
  if (calRow) {
    const rendered = renderCalendar(parseGtfsCalendar(calRow));
    if (rendered) return rendered;
  }
  return summariseAddedDates(gtfs.addedDatesByService.get(serviceId));
}

// ─── Build the trains dict ───────────────────────────────────────────────────

const fmtTime = (t) => {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length < 2) return null;
  let h = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(h)) return null;
  h %= 24; // GTFS uses 24:00+ for after-midnight
  return `${String(h).padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
};

// Normalise a route name / station for matching: fold accents (Montréal →
// montreal), lowercase, collapse punctuation to single spaces. Accent-folding
// matters for bilingual feeds like VIA Rail.
function normLabel(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Does a route endpoint (already normalised) start with an allowlist city?
// Token-aware so "toronto union station" matches "toronto" but "new york"
// never matches "york".
function endpointMatchesCity(endpointNorm, cityNorm) {
  if (!cityNorm || !endpointNorm) return false;
  return endpointNorm === cityNorm || endpointNorm.startsWith(`${cityNorm} `);
}

// Order-independent endpoint-pair match: keep a route when its two termini are
// the allowlisted city pair in either direction.
function pairMatches(originNorm, destNorm, from, to) {
  const f = normLabel(from);
  const t = normLabel(to);
  return (
    (endpointMatchesCity(originNorm, f) && endpointMatchesCity(destNorm, t)) ||
    (endpointMatchesCity(originNorm, t) && endpointMatchesCity(destNorm, f))
  );
}

// One direction only, for the named entries below: from must be the first
// terminus and to the last, never the other way round. Both sides arrive
// already normalised — this runs once per trip per entry, and normalising the
// entry inside it would re-fold the same two strings 39 000 times.
function orientedMatch(originNorm, destNorm, fromNorm, toNorm) {
  return (
    endpointMatchesCity(originNorm, fromNorm) &&
    endpointMatchesCity(destNorm, toNorm)
  );
}

/**
 * Resolve each named pair entry to the one trip it describes, scanning every
 * trip in the feed rather than one representative per route.
 *
 * Both halves of that matter for a feed like SNCF's. Its route_long_name is
 * "-" for six of the eleven Intercites de Nuit and files two of the named ones
 * under another train's corridor, so the route is not a usable address; and a
 * single route_id there carries both directions plus the portions that split
 * at Toulouse, so "the fullest trip on this route" answers a question nobody
 * asked. An oriented endpoint pair addresses exactly one train, and the entry
 * carries the operator's own label for it so the trains dict comes out keyed
 * the way the enrichment will look it up.
 *
 * Endpoints are read from the first and last located stop, which is two map
 * lookups per trip — the full station list is only built for the winner.
 */
function resolveNamedTrips(namedEntries, gtfs) {
  const best = new Map(); // name → { trip, stopCount }
  const wanted = namedEntries.map((e) => ({
    name: e.name,
    fromNorm: normLabel(e.from),
    toNorm: normLabel(e.to),
  }));
  for (const trip of gtfs.trips) {
    const sts = gtfs.stopTimesByTrip.get(trip.trip_id);
    if (!sts || sts.length < 2) continue;
    // An allowlist of sleepers has no use for a day train, and taking one is
    // worse than taking nothing: SNCF's fullest Paris Austerlitz → Toulouse
    // Matabiau trip is the 08:27 Intercités via Limoges, which would have
    // overwritten the night train's Montauban routing with a different
    // corridor under the night train's own number.
    if (!crossesMidnight(sts)) continue;
    const first = firstLocatedStop(sts, gtfs, 1);
    const last = firstLocatedStop(sts, gtfs, -1);
    if (!first || !last || first === last) continue;
    const originNorm = normLabel(first);
    const destNorm = normLabel(last);
    for (const e of wanted) {
      if (!orientedMatch(originNorm, destNorm, e.fromNorm, e.toNorm)) continue;
      const prev = best.get(e.name);
      if (!prev || sts.length > prev.stopCount) {
        best.set(e.name, { trip, stopCount: sts.length });
      }
    }
  }
  return best;
}

/** "25:10:00" → 90600. GTFS writes a past-midnight time as hours ≥ 24. */
function timeToSeconds(hhmmss) {
  const parts = String(hhmmss ?? "").trim().split(":");
  if (parts.length < 2) return null;
  const [h, m, sec] = parts.map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 3600 + m * 60 + (Number.isFinite(sec) ? sec : 0);
}

/**
 * Does this trip still be running after midnight? Two ways a feed can say so:
 * the hours-≥-24 notation GTFS specifies, and — for a feed that resets at
 * midnight instead — an arrival earlier in the day than the departure.
 */
function crossesMidnight(sts) {
  const dep = timeToSeconds(sts[0]?.departure ?? sts[0]?.arrival);
  const lastSt = sts[sts.length - 1];
  const arr = timeToSeconds(lastSt?.arrival ?? lastSt?.departure);
  if (dep === null || arr === null) return false;
  return arr >= 24 * 3600 || arr < dep;
}

// The first (dir 1) or last (dir -1) stop of a trip that has coordinates.
function firstLocatedStop(sts, gtfs, dir) {
  const order = dir === -1 ? [...sts].reverse() : sts;
  for (const st of order) {
    const stop = gtfs.stopsById.get(st.stop_id);
    if (stop && stop.lat !== null && stop.lon !== null) return stop.name;
  }
  return null;
}

// Pick the representative trip for a route: the one serving the most located
// stations (full corridor), so seasonal/partial runs don't truncate it.
function representativeTrip(trips, gtfs) {
  let best = null;
  let bestStations = [];
  for (const t of trips) {
    const stations = stationsForTrip(t.trip_id, gtfs);
    if (stations.length > bestStations.length) {
      best = t;
      bestStations = stations;
    }
  }
  return { trip: best, stations: bestStations };
}

// Build the ordered station list for a trip from its stop_times.
function stationsForTrip(tripId, gtfs) {
  const sts = gtfs.stopTimesByTrip.get(tripId) || [];
  const stations = [];
  const seen = new Set();
  for (const st of sts) {
    const stop = gtfs.stopsById.get(st.stop_id);
    if (!stop || stop.lat === null || stop.lon === null) continue;
    if (seen.has(stop.name)) continue;
    seen.add(stop.name);
    stations.push({
      name: stop.name,
      // GTFS stop_id is the operator station code (Amtrak: CHI, VIA: MTL).
      code: st.stop_id,
      location: { latitude: stop.lat, longitude: stop.lon },
      arrival: fmtTime(st.arrival),
      departure: fmtTime(st.departure),
      pickup: true,
      dropoff: true,
    });
  }
  return stations;
}

/**
 * Build the standard trains dict for the allowlisted routes of one feed.
 *
 * Allowlist entries can take any of three forms (mix freely):
 *   - a string            → matched against route_long_name / route_short_name
 *                           / route_id, accent/space/punctuation-insensitive.
 *                           Good for Amtrak, whose route_long_name is the
 *                           service name.
 *   - { from, to }        → matched against the route's two terminal stations,
 *                           in either direction and accent-folded. Robust for
 *                           feeds that name routes by city pair (VIA Rail:
 *                           "Montréal - Halifax"), where exact-name matching is
 *                           brittle.
 *   - { from, to, name }  → the same pair, but oriented (from must be the
 *                           origin) and keyed by `name` instead of the route's.
 *                           For a feed whose routes are not addresses: SNCF
 *                           calls six of its eleven night trains "-", files
 *                           two of the named ones under another corridor, and
 *                           runs both directions plus the split portions under
 *                           one route_id. Naming the entry both disambiguates
 *                           the train and lets the trains dict come out keyed
 *                           by the operator's own label, which is what the
 *                           trainsByNumber enrichment looks a row up by.
 *
 * @param {object} args
 * @param {object} args.gtfs       result of loadGtfsDir()
 * @param {Array<string|{from:string,to:string}>} args.allowlist  routes to keep
 * @param {string} args.agency     agency_id stamp (e.g. "AMTK")
 * @param {string} args.operator   display operator name (e.g. "Amtrak")
 * @param {(msg: string) => void} [args.log]
 * @param {(name: string) => string} [args.canonicalizeName]
 *                                 optional per-stop name canonicaliser (the
 *                                 shared station-alias table), applied before
 *                                 stationRenames.
 * @param {object} [args.stats]    optional out-param filled with
 *                                 { matched, unmatched, feedRouteCount } so the
 *                                 adapter can flag naming drift (an allowlist
 *                                 entry that matched nothing).
 * @returns {Record<string, object>} trains dict in the shape build-initial-data expects
 */
export function buildSleeperTrains({
  gtfs,
  allowlist,
  agency,
  operator,
  log = () => {},
  stats = null,
  stationRenames = null,
  canonicalizeName = null,
}) {
  // Split the allowlist into name entries and endpoint-pair entries.
  const nameEntries = [];
  const pairEntries = [];
  const namedEntries = [];
  for (const e of allowlist || []) {
    if (typeof e === "string" && e.trim()) {
      nameEntries.push({ raw: e, norm: normLabel(e) });
    } else if (e && e.from && e.to && e.name) {
      namedEntries.push({
        raw: `${e.name} (${e.from} → ${e.to})`,
        from: e.from,
        to: e.to,
        name: String(e.name).trim(),
      });
    } else if (e && e.from && e.to) {
      pairEntries.push({ raw: `${e.from} – ${e.to}`, from: e.from, to: e.to });
    }
  }
  const matchedEntries = new Set();
  const renameMap =
    stationRenames && Object.keys(stationRenames).length
      ? new Map(
          Object.entries(stationRenames).map(([k, v]) => [k.toLowerCase(), v]),
        )
      : null;
  // Alias table first (feed spelling → the spelling the rest of the payload
  // uses), then the source's own explicit corrections, which therefore get the
  // last word on anything the table gets wrong for this feed.
  const renameStations = (list) =>
    !renameMap && !canonicalizeName
      ? list
      : list.map((s) => {
          if (!s?.name) return s;
          let name = canonicalizeName ? canonicalizeName(s.name) : s.name;
          name = renameMap?.get(String(name).toLowerCase()) ?? name;
          return name !== s.name ? { ...s, name } : s;
        });

  // Group every trip by its route; allowlist filtering happens per route below.
  const tripsByRoute = new Map();
  for (const t of gtfs.trips) {
    if (!gtfs.routesById.has(t.route_id)) continue;
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }

  const trains = {};

  const makeTrain = (lineName, trip, stations) => {
    // Geometry: prefer the GTFS shape; fall back to the station chain.
    const shapePts = trip.shape_id ? gtfs.shapePoints.get(trip.shape_id) : null;
    const positions =
      shapePts && shapePts.length >= 2
        ? shapePts.map((p) => [p.lat, p.lon])
        : stations.map((s) => [s.location.latitude, s.location.longitude]);
    return {
      lineName,
      operator,
      agency_id: agency,
      frequency: serviceDisplay(trip.service_id, gtfs),
      polyline: polyline.encode(positions),
      stations: renameStations(stations),
    };
  };

  // Two trains under one key is one train: a feed is free to give several
  // route_ids the same route_long_name (SNCF gives six of them "-"), and the
  // last one written would silently be the only one kept.
  const claimKey = (preferred, suffix) =>
    trains[preferred] === undefined ? preferred : `${preferred} (${suffix})`;

  // Named entries first, so they get the unsuffixed key.
  if (namedEntries.length) {
    const resolved = resolveNamedTrips(namedEntries, gtfs);
    for (const e of namedEntries) {
      const hit = resolved.get(e.name);
      if (!hit) continue;
      const stations = stationsForTrip(hit.trip.trip_id, gtfs);
      if (stations.length < 2) {
        log(`skip ${e.raw}: no trip with ≥2 located stops`);
        continue;
      }
      matchedEntries.add(e.raw);
      trains[claimKey(e.name, hit.trip.trip_id)] = makeTrain(
        e.name,
        hit.trip,
        stations,
      );
    }
  }

  for (const [routeId, trips] of tripsByRoute.entries()) {
    const route = gtfs.routesById.get(routeId);
    const nameNorms = [
      route.route_long_name,
      route.route_short_name,
      route.route_id,
    ].map(normLabel);

    // Cheap name match first; only build the representative trip (which walks
    // stop_times) when endpoints are actually needed for pair matching.
    const nameHits = nameEntries.filter(
      (ne) => ne.norm && nameNorms.includes(ne.norm),
    );

    let rep = null;
    const getRep = () => (rep ??= representativeTrip(trips, gtfs));

    const pairHits = [];
    if (pairEntries.length) {
      const stations = getRep().stations;
      if (stations.length >= 2) {
        const originNorm = normLabel(stations[0].name);
        const destNorm = normLabel(stations[stations.length - 1].name);
        for (const pe of pairEntries) {
          if (pairMatches(originNorm, destNorm, pe.from, pe.to)) pairHits.push(pe);
        }
      }
    }

    if (nameHits.length === 0 && pairHits.length === 0) continue;
    [...nameHits, ...pairHits].forEach((h) => matchedEntries.add(h.raw));

    const { trip: best, stations: bestStations } = getRep();
    const routeName =
      (route.route_long_name || route.route_short_name || "").trim() ||
      `Train ${routeId}`;
    if (!best || bestStations.length < 2) {
      log(`skip ${routeName}: no trip with ≥2 located stops`);
      continue;
    }

    trains[claimKey(routeName, routeId)] = makeTrain(
      routeName,
      best,
      bestStations,
    );
  }

  const unmatched = [...nameEntries, ...pairEntries, ...namedEntries]
    .map((e) => e.raw)
    .filter((raw) => !matchedEntries.has(raw));
  if (stats) {
    stats.matched = [...matchedEntries];
    stats.unmatched = unmatched;
    stats.feedRouteCount = tripsByRoute.size;
  }
  if (unmatched.length) {
    log(
      `WARNING: ${unmatched.length} allowlist entr${unmatched.length === 1 ? "y" : "ies"} matched no feed route: ${unmatched.join(", ")}`,
    );
  }
  log(`built ${Object.keys(trains).length} ${operator} sleeper route(s)`);
  return trains;
}
