#!/usr/bin/env node
/**
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
 *   node scripts/parse-pkp-gtfs.js
 *   node scripts/parse-pkp-gtfs.js /path/to/unpacked-gtfs-dir   # skip download
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

/**
 * @param {string} key
 * @param {object[]} icTrips
 * @param {Map<string, object>} routesById
 */
function findTripForTrainKey(key, icTrips, routesById) {
  for (const t of icTrips) {
    const route = routesById.get(t.route_id);
    if (!route || route.agency_id !== "IC") continue;
    if (String(t.route_id).includes("_BUS")) continue;
    const sid = t.shape_id || "";
    if (!sid.startsWith("RAIL_")) continue;

    const plk = (t.plk_train_number || "").split("/")[0];
    if (plk === key) return t;

    const ts = t.trip_short_name || "";
    if (ts.startsWith(`${key}/`) || ts.startsWith(`${key} `)) return t;
  }
  return null;
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

  /** @type {Record<string, { shapeId: string, pointCount: number, positions: number[][] }>} */
  const byTrainKey = {};

  for (const key of neededKeys) {
    const trip = findTripForTrainKey(key, icTrips, routesById);
    if (!trip) {
      console.warn("No GTFS rail trip for BoT key:", key);
      continue;
    }
    const sid = trip.shape_id;
    const raw = shapePoints.get(sid);
    if (!raw || raw.length < 2) {
      console.warn("Missing shape points for", key, sid);
      continue;
    }
    const positions = raw.map((p) => [p.lat, p.lon]);
    byTrainKey[key] = {
      shapeId: sid,
      pointCount: positions.length,
      positions,
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
