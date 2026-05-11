#!/usr/bin/env node
/**
 * Checked-in artifact (like parse-regiojet-gtfs): regenerate, then commit the JSON.
 *
 * Builds public/data/gtfs/pkpTrainShapes.json from the Polish GTFS feed (shapes.txt)
 * plus PKP / PKP/ČD trip labels from Back-on-Track trips.json (night-train scope).
 *
 * BoT defines *which* train numbers we care about; GTFS (mkuran polish_trains) supplies
 * geometry. Keep extractKeysFromTripLabel in sync with src/lib/pkpTrainKeyExtract.js.
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
  const longRuns = s.match(/\d{4,6}/g) || [];
  longRuns.forEach((n) => push(n));
  return keys;
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
 * @param {Map<string, Array<{seq: number, stop_id: string}>>} stopTimesByTripId
 * @param {Map<string, string>} stopsById
 * @returns {{ positions: number[][], stops: string[], rail_segments: {positions: number[][]}[], bus_segments: {positions: number[][]}[] } | null}
 */
function findTrainDataForKey(
  key,
  icTrips,
  routesById,
  shapePoints,
  stopTimesByTripId,
  stopsById,
  busLegsByParent,
) {
  const candidates = [];
  for (const t of icTrips) {
    const route = routesById.get(t.route_id);
    if (!route || route.agency_id !== "IC") continue;
    if (String(t.route_id).includes("_BUS")) continue;
    const sid = t.shape_id || "";
    if (!sid.startsWith("RAIL_")) continue;

    const plk = (t.plk_train_number || "").split("/")[0];
    const ts = t.trip_short_name || "";
    if (plk === key || ts.startsWith(`${key}/`) || ts.startsWith(`${key} `)) {
      candidates.push(t);
    }
  }
  if (candidates.length === 0) return null;

  // Group trips by parent trip_id (strip _LEG\d+ suffix so legs of the same
  // service run are combined rather than competing with each other).
  const groups = new Map();
  for (const t of candidates) {
    const prefix = t.trip_id.replace(/_LEG\d+$/, "");
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(t);
  }

  let bestResult = null;
  let bestCount = 0;

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
    }

    if (currentSeg.length > 0) railSegments.push({ positions: [...currentSeg] });

    const combined = railSegments.flatMap((s) => s.positions);
    if (combined.length <= bestCount) continue;

    // Collect ordered stop names for included legs.
    const combinedStops = [];
    const seenStops = new Set();
    for (const tripId of includedTripIds) {
      const stopTimes = stopTimesByTripId.get(tripId) || [];
      stopTimes.sort((a, b) => a.seq - b.seq);
      for (const st of stopTimes) {
        const name = stopsById.get(st.stop_id) || st.stop_id;
        if (!seenStops.has(name)) {
          seenStops.add(name);
          combinedStops.push(name);
        }
      }
    }

    bestCount = combined.length;
    bestResult = { positions: combined, stops: combinedStops, railSegments, busSegments };
  }

  if (!bestResult || bestResult.positions.length < 2) return null;
  return {
    positions: bestResult.positions,
    stops: bestResult.stops,
    rail_segments: bestResult.railSegments,
    bus_segments: bestResult.busSegments,
  };
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
  const botTrips = await fetchJson(BOT_TRIPS_URL);
  const neededKeys = new Set();
  for (const trip of Object.values(botTrips)) {
    const ag = trip.agency_id;
    if (ag !== "PKP" && ag !== "PKP/ČD") continue;
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

  const routesById = new Map();
  routes.forEach((r) => routesById.set(r.route_id, r));

  const icTrips = trips.filter((t) => {
    const route = routesById.get(t.route_id);
    return route && route.agency_id === "IC";
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
  stopsCsv.forEach((row) => {
    if (row.stop_id) stopsById.set(row.stop_id, row.stop_name || row.stop_id);
  });

  // Build stop-times index for IC trips (RAIL + BUS legs) to keep memory usage reasonable.
  const icTripIdSet = new Set(icTrips.map((t) => t.trip_id));
  const stopTimesByTripId = new Map();
  stopTimesCsv.forEach((row) => {
    if (!icTripIdSet.has(row.trip_id)) return;
    if (!stopTimesByTripId.has(row.trip_id))
      stopTimesByTripId.set(row.trip_id, []);
    stopTimesByTripId
      .get(row.trip_id)
      .push({ seq: Number.parseInt(row.stop_sequence || "0", 10), stop_id: row.stop_id });
  });

  // Index BUS legs by parent trip prefix so findTrainDataForKey can look up
  // authoritative stop names from the explicit bus leg rather than inferring them.
  const busLegsByParent = new Map();
  icTrips.forEach((t) => {
    if (!String(t.route_id).includes("_BUS")) return;
    const prefix = t.trip_id.replace(/_LEG\d+$/, "");
    if (!busLegsByParent.has(prefix)) busLegsByParent.set(prefix, []);
    busLegsByParent.get(prefix).push(t);
  });

  /** @type {Record<string, { pointCount: number, positions: number[][], stops: string[] }>} */
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
    );
    if (!result) {
      console.warn("No GTFS rail trip for BoT key:", key);
      continue;
    }
    byTrainKey[key] = {
      pointCount: result.positions.length,
      positions: result.positions,
      stops: result.stops,
      rail_segments: result.rail_segments,
      bus_segments: result.bus_segments.length > 0 ? result.bus_segments : undefined,
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
