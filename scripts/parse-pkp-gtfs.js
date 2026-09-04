#!/usr/bin/env node
/**
 * Checked-in artifact (like parse-regiojet-gtfs): regenerate, then commit the JSON.
 *
 * Builds public/data/gtfs/pkpTrainShapes.json from the Polish GTFS feed (shapes.txt)
 * plus PKP / PKP/ČD trip labels from Back-on-Track trips.json (night-train scope)
 * and Leo Express sleeper numbers discovered from the same mkuran feed.
 *
 * BoT defines *which* PKP train numbers we care about; GTFS (mkuran polish_trains)
 * supplies geometry. Leo Express sleepers are discovered from LEO stop times
 * (overnight + 12h+) because BoT uses different commercial numbers (LE 232/235)
 * than the feed. Keep extractKeysFromTripLabel in sync with pkpTrainKeyExtract.js.
 *
 * Prerequisites: unzip on PATH. Default: downloads feed to gtfs-data/polish-trains.zip
 * and extracts to gtfs-data/polish-trains-unpacked/
 *
 * Usage:
 *   npm run parse-pkp-gtfs
 *   node scripts/parse-pkp-gtfs.js /path/to/unpacked-gtfs-dir   # skip download
 *
 * Same workflow as RegioJet: commit public/data/gtfs/pkpTrainShapes.json; /data shows freshness.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execSync } = require("node:child_process");

const DEFAULT_FEED_URL = "https://mkuran.pl/gtfs/polish_trains.zip";
const BOT_TRIPS_URL =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/trips.json";

/** @param {string} label */
function extractKeysFromTripLabel(label) {
  const s = String(label || "");
  const keys = [];
  const push = (k) => {
    if (k && !keys.includes(k)) keys.push(k);
  };
  const ic = s.match(/\bIC\s+(\d{3,6})\b/i);
  if (ic) push(ic[1]);
  const tlk = s.match(/\bTLK\s+(\d{3,6})\b/i);
  if (tlk) push(tlk[1]);
  const slash = s.match(/\/(\d{3,6})(?:\D|$)/);
  if (slash) push(slash[1]);
  const en = s.match(/\bEN\s+(\d{3,6})\b/i);
  if (en) push(en[1]);
  const ec = s.match(/\bEC\s+(\d{3,6})\b/i);
  if (ec) push(ec[1]);
  // Keep in sync with src/lib/pkpTrainKeyExtract.js (Leo Express labels).
  const le = s.match(/\bLE\s+(\d{3,6})\b/i);
  if (le) push(le[1]);
  const longRuns = s.match(/\d{4,6}/g) || [];
  longRuns.forEach((n) => push(n));
  return keys;
}

// Canonicalize a GTFS stop name to its Back-on-Track spelling via the shared
// alias table (data/overrides/station-aliases.json). The Polish feed carries
// foreign stops ASCII-folded ("Kolin", "Praha Hlavni Nadrazi"); folding them to
// the BoT form ("Kolín") is what lets those stations match BoT's coordinate-
// bearing stops on the map — otherwise "Kolin" resolves to an unrelated Polish
// placeholder stop. Unmapped names pass through unchanged. Mirrors
// canonicalizeStationName (pkp-plk.mjs) / resolveCanonicalStationName.
const STATION_ALIASES = require("../data/overrides/station-aliases.json");
function canonicalizeStationName(name) {
  if (!name) return name;
  return STATION_ALIASES[String(name).toLowerCase().trim()] ?? name;
}

// Keep in sync with normalizeCity in src/lib/pkpTrainKeyExtract.js — used to
// tell distinct corridors of a reused train number apart.
function normalizeCityLocal(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .split(/\s+/)[0]
    .replace(/[^\p{L}\p{N}-]/gu, "");
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => {
          d += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// Nightly scrape has a committed copy; use it when GitHub raw is unreachable
// (dev machines, rate limits) so parse-pkp-gtfs still produces Leo Express keys.
function loadLocalBotTrips(root) {
  const local = path.join(root, "public", "data", "scraped", "backontrack-trips.json");
  if (!fs.existsSync(local)) return null;
  const envelope = JSON.parse(fs.readFileSync(local, "utf8"));
  return envelope?.data ?? envelope;
}

function downloadFile(url, destPath) {
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

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    const out = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? "";
    });
    return out;
  });
}

/**
 * Format a GTFS time string ("HH:MM:SS", possibly >= 24h for after-midnight)
 * into a short "HH:MM" wall-clock string. GTFS uses 24:00+ to mean "next day",
 * so we wrap the hour back into 0-23 for display.
 * @param {string} t
 * @returns {string|null}
 */
function fmtTime(t) {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length < 2) return null;
  let h = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(h)) return null;
  h %= 24; // 25:30 -> 01:30
  return `${String(h).padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Summarise the service calendar for a GTFS service_id into a human display.
 * The Polish feed ships only calendar_dates.txt (explicit run-dates, no weekly
 * calendar.txt), so we derive the date window and which weekdays the train runs.
 *
 * @param {string[]} serviceIds  all service_ids the train runs under
 * @param {Map<string, string[]>} datesByService  service_id -> ["YYYYMMDD", ...]
 * @returns {{ validFrom: string|null, validUntil: string|null, days: string|null }}
 */
function summariseCalendar(serviceIds, datesByService) {
  // Union run-dates across every service the train uses so "days" reflects the
  // full weekly pattern, not just one instance.
  const dates = [];
  for (const sid of serviceIds || []) {
    for (const d of datesByService.get(sid) || []) dates.push(d);
  }
  if (dates.length === 0) return { validFrom: null, validUntil: null, days: null };
  const sorted = [...dates].sort();
  const validFrom = sorted[0];
  const validUntil = sorted[sorted.length - 1];

  // Which weekdays does it run on? (Sun=0 .. Sat=6)
  const weekdays = new Set();
  for (const d of sorted) {
    const dt = new Date(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
    );
    weekdays.add(dt.getDay());
  }
  let days;
  if (weekdays.size === 7) {
    days = "Daily";
  } else {
    // List in Mon..Sun order so it reads naturally.
    const order = [1, 2, 3, 4, 5, 6, 0];
    days = order
      .filter((d) => weekdays.has(d))
      .map((d) => WEEKDAY_SHORT[d])
      .join(", ");
  }
  return { validFrom, validUntil, days };
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Legs connected by a bus relay > this threshold km are part of the same
// through-service (e.g. TLK 38170 Kraków↔Kołobrzeg, gap ~25.7 km).
// Legs separated by < this threshold are local connectors to a different
// service (e.g. IC 16170 terminates at Jelenia Góra; the LEG2 Szklarska
// branch is a separate local train, gap ~15 km).
const BUS_RELAY_MIN_KM = 20;

/**
 * Returns positions, stop names, rail segments and bus-connector segments for a
 * train key.  Multi-leg trips (e.g. RAIL_442 LEG0 + RAIL_443 LEG2) are combined
 * when the bus transfer between legs is ≥ BUS_RELAY_MIN_KM (same through-service).
 * Legs separated by a shorter gap are local connectors and excluded from the rail
 * shape; a bus_segment is recorded for the excluded section instead.
 *
 * For included long-relay legs the bus gap between the two rail shapes is also
 * stored as a bus_segment, and the two rail shapes are stored as separate
 * rail_segments so rendering can colour them individually.
 *
 * @param {string} key
 * @param {object[]} icTrips
 * @param {Map<string, object>} routesById
 * @param {Map<string, object[]>} shapePoints
 * @param {Map<string, Array<{seq: number, stop_id: string, arrival: string, departure: string}>>} stopTimesByTripId
 * @param {Map<string, string>} stopsById
 * @returns {{ positions: number[][], stops: {name: string, arr: string|null, dep: string|null}[], rail_segments: {positions: number[][]}[], bus_segments: {positions: number[][]}[], serviceIds: string[] } | null}
 */
function findTrainDataForKey(
  key,
  icTrips,
  routesById,
  shapePoints,
  stopTimesByTripId,
  stopsById,
  busLegsByParent,
  stopCoordsById,
) {
  const candidates = [];
  for (const t of icTrips) {
    const route = routesById.get(t.route_id);
    if (!route || (route.agency_id !== "IC" && route.agency_id !== "LEO")) continue;
    if (String(t.route_id).includes("_BUS")) continue;
    const sid = t.shape_id || "";
    if (!sid.startsWith("RAIL_")) continue;

    // A train number can sit in any slash-segment of plk_train_number (the
    // Carpathia's Praha portion is "417/50443"), so match every segment.
    const plkSegs = (t.plk_train_number || "").split("/");
    const ts = t.trip_short_name || "";
    if (
      plkSegs.includes(key) ||
      ts === key ||
      ts.startsWith(`${key}/`) ||
      ts.startsWith(`${key} `)
    ) {
      candidates.push(t);
    }
  }
  if (candidates.length === 0) return null;

  // Every distinct service this train runs under (across all date-instances),
  // so the calendar summary captures the full weekly pattern.
  const serviceIds = [
    ...new Set(candidates.map((c) => c.service_id).filter(Boolean)),
  ];

  // Group trips by parent trip_id (strip _LEG\d+ suffix so legs of the same
  // service run are combined rather than competing with each other).
  const groups = new Map();
  for (const t of candidates) {
    const prefix = t.trip_id.replace(/_LEG\d+$/, "");
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(t);
  }

  const groupResults = [];

  for (const [groupPrefix, trips] of groups.entries()) {
    // Sort legs in ascending order so shapes are concatenated start → end.
    trips.sort((a, b) => {
      const legA = Number((a.trip_id.match(/_LEG(\d+)$/) || [, "0"])[1]);
      const legB = Number((b.trip_id.match(/_LEG(\d+)$/) || [, "0"])[1]);
      return legA - legB;
    });

    // Look up bus stop names from the explicit BUS leg for this group.
    // Falls back to inferring from RAIL endpoints if no BUS leg is found.
    const busLegsForGroup = (busLegsByParent && busLegsByParent.get(groupPrefix)) || [];
    const getBusLegStopNames = (prevLegNum, nextLegNum) => {
      for (const bl of busLegsForGroup) {
        const legNum = Number((bl.trip_id.match(/_LEG(\d+)$/) || [, "-1"])[1]);
        if (legNum > prevLegNum && legNum < nextLegNum) {
          const sts = (stopTimesByTripId.get(bl.trip_id) || [])
            .slice().sort((a, b) => a.seq - b.seq);
          if (sts.length >= 2) {
            return {
              from: stopsById.get(sts[0].stop_id) || null,
              to: stopsById.get(sts[sts.length - 1].stop_id) || null,
            };
          }
        }
      }
      return null;
    };

    const getLastStop = (tripId) => {
      const sts = (stopTimesByTripId.get(tripId) || []).slice().sort((a, b) => a.seq - b.seq);
      return sts.length > 0 ? stopsById.get(sts[sts.length - 1].stop_id) || null : null;
    };
    const getFirstStop = (tripId) => {
      const sts = (stopTimesByTripId.get(tripId) || []).slice().sort((a, b) => a.seq - b.seq);
      return sts.length > 0 ? stopsById.get(sts[0].stop_id) || null : null;
    };

    const railSegments = [];
    const busSegments = [];
    const includedTripIds = [];
    let currentSeg = [];
    let lastIncludedTripId = null;
    let lastIncludedLegNum = -1;
    let firstIncludedLegNum = Infinity;

    for (const t of trips) {
      const raw = shapePoints.get(t.shape_id);
      if (!raw || raw.length < 2) continue;

      const thisLegNum = Number((t.trip_id.match(/_LEG(\d+)$/) || [, "0"])[1]);

      if (currentSeg.length > 0) {
        const prevLast = currentSeg[currentSeg.length - 1];
        const currFirst = [raw[0].lat, raw[0].lon];
        const gapKm = haversineKm(prevLast, currFirst);

        // Try to get from/to from the explicit BUS leg between these two RAIL legs.
        const busNames = getBusLegStopNames(lastIncludedLegNum, thisLegNum);

        if (gapKm < BUS_RELAY_MIN_KM) {
          // Local connector — skip this leg. Record bus segment from rail
          // endpoint to the end of the excluded RAIL leg (the actual terminus
          // reached via bus+local, e.g. Szklarska Poręba Górna).
          // Use the excluded RAIL leg's last stop for `to` because the official
          // replacement service is advertised as running to that station, even
          // though the BUS leg itself may terminate at an intermediate stop.
          const legLast = [raw[raw.length - 1].lat, raw[raw.length - 1].lon];
          busSegments.push({
            positions: [prevLast, legLast],
            from: busNames?.from ?? getLastStop(lastIncludedTripId),
            to: getLastStop(t.trip_id),
          });
          continue;
        }

        // Long bus relay — save current rail segment, record the relay gap.
        railSegments.push({ positions: [...currentSeg] });
        busSegments.push({
          positions: [prevLast, currFirst],
          from: busNames?.from ?? getLastStop(lastIncludedTripId),
          to: busNames?.to ?? getFirstStop(t.trip_id),
        });
        currentSeg = [];
      }

      raw.forEach((p) => currentSeg.push([p.lat, p.lon]));
      includedTripIds.push(t.trip_id);
      lastIncludedTripId = t.trip_id;
      lastIncludedLegNum = thisLegNum;
      if (thisLegNum < firstIncludedLegNum) firstIncludedLegNum = thisLegNum;
    }

    if (currentSeg.length > 0) railSegments.push({ positions: [...currentSeg] });

    const combined = railSegments.flatMap((s) => s.positions);
    if (combined.length < 2) continue;

    // Replacement-bus legs that EXTEND the journey past the rail shape — a BUS
    // leg before the first rail leg (leading) or after the last rail leg
    // (trailing). The feed gives them stop_times but no shape (e.g.
    // Lębork→Łeba while that section is closed for works, or Jelenia
    // Góra→Szklarska Poręba). We append/prepend their stops so the bundle
    // reaches the real terminus, and add a straight connector as a bus segment.
    // Bus legs BETWEEN two rail legs are handled inside the loop above; the
    // leg-number range check here skips them.
    let leadingBusLeg = null;
    let trailingBusLeg = null;
    if (includedTripIds.length > 0) {
      for (const bl of busLegsForGroup) {
        const legNum = Number((bl.trip_id.match(/_LEG(\d+)$/) || [, "-1"])[1]);
        if (legNum >= 0 && legNum < firstIncludedLegNum) leadingBusLeg = bl;
        else if (legNum > lastIncludedLegNum) trailingBusLeg = bl;
      }
    }
    const busLegStopTimes = (bl) =>
      bl
        ? (stopTimesByTripId.get(bl.trip_id) || [])
            .slice()
            .sort((a, b) => a.seq - b.seq)
        : [];
    const leadingBusStopTimes = busLegStopTimes(leadingBusLeg);
    const trailingBusStopTimes = busLegStopTimes(trailingBusLeg);
    const busLegCoords = (sts) =>
      sts.map((s) => stopCoordsById.get(s.stop_id)).filter(Boolean);

    if (leadingBusStopTimes.length >= 2 && railSegments.length > 0) {
      const coords = busLegCoords(leadingBusStopTimes);
      if (coords.length >= 2) {
        busSegments.unshift({
          positions: coords,
          from: stopsById.get(leadingBusStopTimes[0].stop_id) || null,
          to:
            stopsById.get(
              leadingBusStopTimes[leadingBusStopTimes.length - 1].stop_id,
            ) || null,
        });
      }
    }
    if (trailingBusStopTimes.length >= 2 && railSegments.length > 0) {
      const coords = busLegCoords(trailingBusStopTimes);
      if (coords.length >= 2) {
        busSegments.push({
          positions: coords,
          from: stopsById.get(trailingBusStopTimes[0].stop_id) || null,
          to:
            stopsById.get(
              trailingBusStopTimes[trailingBusStopTimes.length - 1].stop_id,
            ) || null,
        });
      }
    }

    // Collect ordered stops (name + arrival/departure times). A leading bus leg
    // contributes the real origin (e.g. Łeba) before the rail stops; a trailing
    // bus leg contributes the real terminus after them. This lets endpoint
    // matching in the merge succeed against the Back-on-Track route.
    const combinedStops = [];
    const seenStops = new Set();
    const pushStop = (st) => {
      const name = stopsById.get(st.stop_id) || st.stop_id;
      if (!name || seenStops.has(name)) return;
      seenStops.add(name);
      // Coordinates let the compound-label stitcher truncate polylines precisely
      // at junction stations (e.g. Gdynia) instead of by proportional index.
      const coord = stopCoordsById.get(st.stop_id);
      combinedStops.push({
        name,
        arr: fmtTime(st.arrival),
        dep: fmtTime(st.departure),
        lat: coord ? coord[0] : null,
        lon: coord ? coord[1] : null,
      });
    };
    for (const st of leadingBusStopTimes) pushStop(st);
    for (const tripId of includedTripIds) {
      const stopTimes = stopTimesByTripId.get(tripId) || [];
      stopTimes.sort((a, b) => a.seq - b.seq);
      for (const st of stopTimes) pushStop(st);
    }
    for (const st of trailingBusStopTimes) pushStop(st);

    groupResults.push({
      positions: combined,
      stops: combinedStops,
      railSegments,
      busSegments,
    });
  }

  if (groupResults.length === 0) return null;

  // A reused train number can be several distinct trains (e.g. "406" is both
  // the München→Warszawa sleeper and the Bohumín→Warszawa portion of the
  // §). Keep ONE entry per distinct corridor (endpoint signature):
  // longest = the main entry (back-compat), the rest ride along as `variants`
  // so pkpEntryForRoute can pick by endpoint validation instead of losing them.
  groupResults.sort((a, b) => b.positions.length - a.positions.length);
  const seenSig = new Set();
  const distinct = [];
  for (const r of groupResults) {
    const sig = `${normalizeCityLocal(r.stops[0]?.name)}→${normalizeCityLocal(
      r.stops[r.stops.length - 1]?.name,
    )}`;
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    distinct.push(r);
  }

  const main = distinct[0];
  // Variants omit `positions` for the same reason as the main entry above.
  const variants = distinct.slice(1, 4).map((v) => ({
    stops: v.stops,
    rail_segments: v.railSegments,
    bus_segments: v.busSegments.length > 0 ? v.busSegments : undefined,
  }));
  return {
    positions: main.positions,
    stops: main.stops,
    rail_segments: main.railSegments,
    bus_segments: main.busSegments,
    serviceIds,
    variants: variants.length > 0 ? variants : undefined,
  };
}

/** Parse a GTFS clock ("HH:MM:SS", hours may be ≥ 24) to minutes from midnight. */
function gtfsTimeToMinutes(t) {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length < 2) return null;
  const h = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Praha–Warszawa Leo Express seating trains overnight in ~9h. The Frankfurt–
// Przemyśl couchette sleeper is ~19–20h. 12h is the gap between those classes.
const LEO_SLEEPER_MIN_MINUTES = 12 * 60;

/**
 * Find Leo Express sleeper train numbers in the mkuran feed.
 * The feed lumps every LE train under one route_id, so we look at stop times:
 * a sleeper arrives the next calendar day (GTFS hour ≥ 24) and runs ≥ 12h.
 * Returns trip_short_name keys (e.g. "1248") for findTrainDataForKey.
 */
function discoverLeoSleeperKeys(icTrips, routesById, stopTimesByTripId) {
  const keys = new Set();
  for (const t of icTrips) {
    const route = routesById.get(t.route_id);
    if (!route || route.agency_id !== "LEO") continue;
    if (String(t.route_id).includes("_BUS")) continue;
    const sts = stopTimesByTripId.get(t.trip_id);
    if (!sts || sts.length < 2) continue;
    const ordered = [...sts].sort((a, b) => a.seq - b.seq);
    const first = gtfsTimeToMinutes(ordered[0].departure || ordered[0].arrival);
    const last = gtfsTimeToMinutes(
      ordered[ordered.length - 1].arrival || ordered[ordered.length - 1].departure,
    );
    if (first == null || last == null) continue;
    if (last < 24 * 60) continue;
    if (last - first < LEO_SLEEPER_MIN_MINUTES) continue;
    const num = String(t.trip_short_name || "").split("/")[0].trim();
    if (/^\d{3,6}$/.test(num)) keys.add(num);
  }
  return [...keys];
}

async function main() {
  const root = process.cwd();
  const manualGtfsDir = process.argv[2];
  let gtfsDir = manualGtfsDir
    ? path.resolve(root, manualGtfsDir)
    : path.join(root, "gtfs-data", "polish-trains-unpacked");

  if (!manualGtfsDir) {
    const zipDir = path.join(root, "gtfs-data");
    const zipPath = path.join(zipDir, "polish_trains.zip");
    fs.mkdirSync(zipDir, { recursive: true });
    if (!fs.existsSync(path.join(gtfsDir, "trips.txt"))) {
      console.log("Downloading", DEFAULT_FEED_URL);
      await downloadFile(DEFAULT_FEED_URL, zipPath);
      fs.mkdirSync(gtfsDir, { recursive: true });
      execSync(`unzip -o -q "${zipPath}" -d "${gtfsDir}"`, { stdio: "inherit" });
    }
  }

  if (!fs.existsSync(path.join(gtfsDir, "trips.txt"))) {
    console.error("Missing trips.txt in", gtfsDir);
    process.exit(1);
  }

  console.log("Fetching BoT trips for PKP key set…");
  let botTrips;
  try {
    botTrips = await fetchJson(BOT_TRIPS_URL);
  } catch (err) {
    botTrips = loadLocalBotTrips(root);
    if (!botTrips) throw err;
    console.warn("BoT URL failed, using local scraped trips:", err.message);
  }
  const neededKeys = new Set();
  for (const trip of Object.values(botTrips)) {
    // Any operator combo involving PKP (PKP, PKP/ČD, MÁV/PKP, …) — their
    // Polish legs are in this feed.
    if (!String(trip.agency_id || "").includes("PKP")) continue;
    for (const k of extractKeysFromTripLabel(trip.trip_short_name)) {
      neededKeys.add(k);
    }
  }
  console.log("Train keys from BoT PKP trips:", neededKeys.size);

  const routes = readCsv(path.join(gtfsDir, "routes.txt"));
  const trips = readCsv(path.join(gtfsDir, "trips.txt"));
  const shapes = readCsv(path.join(gtfsDir, "shapes.txt"));
  const stopsCsv = readCsv(path.join(gtfsDir, "stops.txt"));
  const stopTimesCsv = readCsv(path.join(gtfsDir, "stop_times.txt"));
  // calendar_dates.txt lists the explicit run-dates per service_id (the Polish
  // feed has no weekly calendar.txt). exception_type 1 = service added on a date.
  const calendarDatesCsv = readCsv(path.join(gtfsDir, "calendar_dates.txt"));
  const datesByService = new Map();
  calendarDatesCsv.forEach((row) => {
    if (row.exception_type !== "1") return;
    if (!datesByService.has(row.service_id))
      datesByService.set(row.service_id, []);
    datesByService.get(row.service_id).push(row.date);
  });

  const routesById = new Map();
  routes.forEach((r) => routesById.set(r.route_id, r));

  const icTrips = trips.filter((t) => {
    const route = routesById.get(t.route_id);
    return route && (route.agency_id === "IC" || route.agency_id === "LEO");
  });

  const shapePoints = new Map();
  shapes.forEach((row) => {
    const id = row.shape_id;
    if (!id) return;
    const lat = Number.parseFloat(row.shape_pt_lat);
    const lon = Number.parseFloat(row.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const seq = Number.parseInt(row.shape_pt_sequence || "0", 10);
    if (!shapePoints.has(id)) shapePoints.set(id, []);
    shapePoints.get(id).push({ seq, lat, lon });
  });

  for (const [, pts] of shapePoints) {
    pts.sort((a, b) => a.seq - b.seq);
  }

  const stopsById = new Map();
  // stop_id -> [lat, lon]; needed to draw replacement-bus connector segments
  // (leading/trailing BUS legs carry stop_times but no shape geometry).
  const stopCoordsById = new Map();
  stopsCsv.forEach((row) => {
    if (!row.stop_id) return;
    stopsById.set(row.stop_id, canonicalizeStationName(row.stop_name || row.stop_id));
    const lat = Number.parseFloat(row.stop_lat);
    const lon = Number.parseFloat(row.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      stopCoordsById.set(row.stop_id, [lat, lon]);
    }
  });

  // Build stop-times index for IC trips (RAIL + BUS legs) to keep memory usage reasonable.
  const icTripIdSet = new Set(icTrips.map((t) => t.trip_id));
  const stopTimesByTripId = new Map();
  stopTimesCsv.forEach((row) => {
    if (!icTripIdSet.has(row.trip_id)) return;
    if (!stopTimesByTripId.has(row.trip_id))
      stopTimesByTripId.set(row.trip_id, []);
    stopTimesByTripId.get(row.trip_id).push({
      seq: Number.parseInt(row.stop_sequence || "0", 10),
      stop_id: row.stop_id,
      arrival: row.arrival_time,
      departure: row.departure_time,
    });
  });

  // Leo Express: BoT commercial numbers (LE 232/235) are not in this feed.
  // Discover sleeper keys from LEO stop times instead of a hardcoded list.
  const leoKeys = discoverLeoSleeperKeys(icTrips, routesById, stopTimesByTripId);
  for (const k of leoKeys) neededKeys.add(k);
  if (leoKeys.length) {
    console.log("Leo Express sleeper keys from GTFS:", leoKeys.join(", "));
  }

  // Index BUS legs by parent trip prefix so findTrainDataForKey can look up
  // authoritative stop names from the explicit bus leg rather than inferring them.
  const busLegsByParent = new Map();
  icTrips.forEach((t) => {
    if (!String(t.route_id).includes("_BUS")) return;
    const prefix = t.trip_id.replace(/_LEG\d+$/, "");
    if (!busLegsByParent.has(prefix)) busLegsByParent.set(prefix, []);
    busLegsByParent.get(prefix).push(t);
  });

  /** @type {Record<string, { pointCount: number, positions: number[][], stops: {name: string, arr: string|null, dep: string|null}[] }>} */
  const byTrainKey = {};

  for (const key of neededKeys) {
    const result = findTrainDataForKey(
      key,
      icTrips,
      routesById,
      shapePoints,
      stopTimesByTripId,
      stopsById,
      busLegsByParent,
      stopCoordsById,
    );
    if (!result) {
      console.warn("No GTFS rail trip for BoT key:", key);
      continue;
    }
    const cal = summariseCalendar(result.serviceIds, datesByService);
    byTrainKey[key] = {
      // `positions` is deliberately NOT written: it is exactly
      // rail_segments.flatMap(s => s.positions), and shipping both doubled the
      // bundle every visitor downloads. hydratePkpBundle() rebuilds it on read.
      pointCount: result.positions.length,
      stops: result.stops,
      rail_segments: result.rail_segments,
      bus_segments: result.bus_segments.length > 0 ? result.bus_segments : undefined,
      // Service calendar derived from GTFS calendar_dates.txt (run-dates window
      // + which weekdays the train runs). Drives the detail-panel validity line.
      validFrom: cal.validFrom || undefined,
      validUntil: cal.validUntil || undefined,
      days: cal.days || undefined,
    };
  }

  const outDir = path.join(root, "public", "data", "gtfs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "pkpTrainShapes.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    source: DEFAULT_FEED_URL,
    botTripsUrl: BOT_TRIPS_URL,
    byTrainKey,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload) + "\n", "utf8");
  console.log(
    "Wrote",
    outPath,
    "—",
    Object.keys(byTrainKey).length,
    "train keys with shapes",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
