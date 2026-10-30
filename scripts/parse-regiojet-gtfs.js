#!/usr/bin/env node
// RegioJet night-train timetables for the detail panel and the browser-side
// via merge (src/lib/rjGtfsMerge.js): public/data/gtfs/rjChopTimetable.json and
// rjPremyslTimetable.json.
//
// Reads RegioJet's own international GTFS (https://ybus.sa.cz/gtfe/international/
// google_transit.zip, no key) — the same feed the `regiojet` registry source
// enriches the map rows from. Runs nightly as the registry's external step
// `regiojet-gtfs`, right after that source has unpacked the feed into
// gtfs-data/regiojet-unpacked/, so the two always read one download.
//
// Trains are picked by NUMBER and oriented endpoints from
// data/sources/regiojet-sleepers.json, never by route_id: between two feed
// drops the Přemyšl route moved from 8393687006 to 8534213024 and its trains
// from 1038/1039 to 1022/1023, and a hard-coded id kept publishing a timetable
// that had expired in June. A file whose trains are missing from the feed is
// not written (and the run fails), so yesterday's file stays rather than an
// empty one.
//
//   npm run parse-gtfs                    # reuse/download the feed
//   npm run parse-gtfs -- path/to/unpacked  # an already-unpacked feed

const fs = require("node:fs");
const path = require("node:path");

const FEED_URL = "https://ybus.sa.cz/gtfe/international/google_transit.zip";
const ALLOWLIST = path.join("data", "sources", "regiojet-sleepers.json");
// Where the `regiojet` source unpacks the same feed (gtfs-sleeper adapter).
const SHARED_DIR = path.join("gtfs-data", "regiojet-unpacked");
// A feed the adapter unpacked this long ago is still tonight's.
const SHARED_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Output file → the train numbers it carries (both directions of one row).
const OUTPUTS = {
  "rjChopTimetable.json": { routeName: "Praha - Chop", trains: ["1020", "1021"] },
  "rjPremyslTimetable.json": { routeName: "Praha - Přemyšl", trains: ["1022", "1023"] },
};

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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatGtfsTime(value) {
  if (!value) return "";
  const parts = value.split(":");
  if (parts.length < 2) return value;
  const totalHours = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
  if (Number.isNaN(totalHours) || Number.isNaN(minutes)) return value;

  const dayOffset = Math.floor(totalHours / 24);
  const hourInDay = totalHours % 24;
  const base = `${pad2(hourInDay)}:${pad2(minutes)}`;
  return dayOffset > 0 ? `${base} (+${dayOffset})` : base;
}

function toNumber(value) {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

function buildServiceDays(calendarRow) {
  if (!calendarRow) {
    return {
      mon: false,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
      sat: false,
      sun: false,
      validFrom: "",
      validUntil: "",
    };
  }

  return {
    mon: calendarRow.monday === "1",
    tue: calendarRow.tuesday === "1",
    wed: calendarRow.wednesday === "1",
    thu: calendarRow.thursday === "1",
    fri: calendarRow.friday === "1",
    sat: calendarRow.saturday === "1",
    sun: calendarRow.sunday === "1",
    validFrom: calendarRow.start_date || "",
    validUntil: calendarRow.end_date || "",
  };
}

function foldName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Same rule as buildSleeperTrains' named entries: "Čop" matches "Čop, žst.".
function startsWithCity(stationName, city) {
  const station = foldName(stationName);
  const wanted = foldName(city);
  return Boolean(wanted) && (station === wanted || station.startsWith(`${wanted} `));
}

function trainNumberOf(trip) {
  return String(trip.trip_short_name || "").replace(/^\s*RJ\s*/i, "").trim();
}

function todayCompact(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

async function resolveFeedDir(root, inputDirArg) {
  if (inputDirArg) return path.resolve(root, inputDirArg);
  const shared = path.join(root, SHARED_DIR);
  const zip = path.join(shared, "feed.zip");
  if (
    fs.existsSync(path.join(shared, "trips.txt")) &&
    fs.existsSync(zip) &&
    Date.now() - fs.statSync(zip).mtimeMs < SHARED_MAX_AGE_MS
  ) {
    console.log(`Reusing ${SHARED_DIR}/ (unpacked by the regiojet source)`);
    return shared;
  }
  const { downloadGtfs } = await import("./lib/gtfs.mjs");
  console.log(`Downloading ${FEED_URL}`);
  await downloadGtfs(FEED_URL, shared);
  return shared;
}

async function main() {
  const root = process.cwd();
  const inputDir = await resolveFeedDir(root, process.argv[2]);
  const outputDir = path.join(root, "public", "data", "gtfs");

  const allowlist = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST), "utf8")).routes;
  const entryByTrain = new Map(allowlist.map((e) => [String(e.name), e]));

  const stops = readCsv(path.join(inputDir, "stops.txt"));
  const routes = readCsv(path.join(inputDir, "routes.txt"));
  const trips = readCsv(path.join(inputDir, "trips.txt"));
  const stopTimes = readCsv(path.join(inputDir, "stop_times.txt"));
  const calendar = readCsv(path.join(inputDir, "calendar.txt"));

  const parentStops = new Map();
  const allStops = new Map();
  stops.forEach((stop) => {
    allStops.set(stop.stop_id, stop);
    if (stop.location_type === "1") {
      parentStops.set(stop.stop_id, stop);
    }
  });
  const resolveStop = (stopId) => {
    const childStop = allStops.get(stopId);
    const parentId = childStop?.parent_station || "";
    return (parentId ? parentStops.get(parentId) : null) || childStop || null;
  };

  const routesById = new Map();
  routes.forEach((route) => {
    routesById.set(route.route_id, route);
  });

  const calendarByServiceId = new Map();
  calendar.forEach((row) => {
    calendarByServiceId.set(row.service_id, row);
  });

  const stopTimesByTripId = new Map();
  stopTimes.forEach((row) => {
    const list = stopTimesByTripId.get(row.trip_id) || [];
    list.push(row);
    stopTimesByTripId.set(row.trip_id, list);
  });
  for (const list of stopTimesByTripId.values()) {
    list.sort(
      (a, b) =>
        Number.parseInt(a.stop_sequence || "0", 10) -
        Number.parseInt(b.stop_sequence || "0", 10),
    );
  }

  // A trip is the allowlisted train when its number matches AND it runs
  // between that entry's endpoints: 1020/1021 is also the Praha–Košice train,
  // under another route, the same night. Expired services are left out.
  const today = todayCompact();
  const isAllowlistedTrip = (trip) => {
    const entry = entryByTrain.get(trainNumberOf(trip));
    if (!entry) return false;
    const service = calendarByServiceId.get(trip.service_id);
    if (service?.end_date && service.end_date < today) return false;
    const sts = stopTimesByTripId.get(trip.trip_id) || [];
    if (sts.length < 2) return false;
    const first = resolveStop(sts[0].stop_id)?.stop_name;
    const last = resolveStop(sts[sts.length - 1].stop_id)?.stop_name;
    return startsWithCity(first, entry.from) && startsWithCity(last, entry.to);
  };

  fs.mkdirSync(outputDir, { recursive: true });

  const missing = [];
  for (const [fileName, spec] of Object.entries(OUTPUTS)) {
    const wanted = new Set(spec.trains);
    const routeTrips = trips
      .filter((trip) => wanted.has(trainNumberOf(trip)) && isAllowlistedTrip(trip))
      .sort(
        (a, b) =>
          trainNumberOf(a).localeCompare(trainNumberOf(b)) ||
          String(calendarByServiceId.get(a.service_id)?.start_date || "").localeCompare(
            String(calendarByServiceId.get(b.service_id)?.start_date || ""),
          ),
      );

    const absent = spec.trains.filter(
      (n) => !routeTrips.some((trip) => trainNumberOf(trip) === n),
    );
    if (absent.length) {
      missing.push(`${fileName}: ${absent.join(", ")}`);
      continue;
    }

    const routeInfo = routesById.get(routeTrips[0].route_id) || {};
    const result = {
      routeId: routeInfo.route_id || "",
      routeName: spec.routeName,
      routeShortName: routeInfo.route_short_name || "",
      routeType: routeInfo.route_type || "",
      source: FEED_URL,
      trips: [],
    };

    routeTrips.forEach((trip) => {
      const service = buildServiceDays(calendarByServiceId.get(trip.service_id));
      const stopsForTrip = (stopTimesByTripId.get(trip.trip_id) || []).map((stopTime) => {
        const resolvedStop = resolveStop(stopTime.stop_id);
        return {
          stopId: stopTime.stop_id,
          name: resolvedStop?.stop_name || stopTime.stop_id,
          lat: toNumber(resolvedStop?.stop_lat),
          lon: toNumber(resolvedStop?.stop_lon),
          arrival: formatGtfsTime(stopTime.arrival_time),
          departure: formatGtfsTime(stopTime.departure_time),
          sequence: Number.parseInt(stopTime.stop_sequence || "0", 10),
        };
      });

      result.trips.push({
        tripId: trip.trip_id,
        trainNumber: trip.trip_short_name || "",
        serviceId: trip.service_id || "",
        serviceDays: {
          mon: service.mon,
          tue: service.tue,
          wed: service.wed,
          thu: service.thu,
          fri: service.fri,
          sat: service.sat,
          sun: service.sun,
        },
        validFrom: service.validFrom,
        validUntil: service.validUntil,
        stops: stopsForTrip,
      });
    });

    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    console.log(`Wrote ${outputPath} (${result.trips.length} trips)`);
  }

  if (missing.length) {
    throw new Error(
      `RegioJet feed no longer carries ${missing.join("; ")} — kept the committed file(s); check ${ALLOWLIST}`,
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
