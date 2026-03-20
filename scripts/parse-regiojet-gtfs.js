#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const TARGET_ROUTE_IDS = new Set(["8185007005", "8393687006"]);
const OUTPUT_FILES = {
  "8185007005": "rjChopTimetable.json",
  "8393687006": "rjPremyslTimetable.json",
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

function main() {
  const root = process.cwd();
  const inputDirArg = process.argv[2];
  const inputDir = inputDirArg
    ? path.resolve(root, inputDirArg)
    : path.join(root, "gtfs-data", "regiojet");
  const outputDir = path.join(root, "public", "data", "gtfs");

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

  const routesById = new Map();
  routes.forEach((route) => {
    routesById.set(route.route_id, route);
  });

  const calendarByServiceId = new Map();
  calendar.forEach((row) => {
    calendarByServiceId.set(row.service_id, row);
  });

  const targetTrips = trips.filter((trip) => TARGET_ROUTE_IDS.has(trip.route_id));
  const tripsById = new Map();
  targetTrips.forEach((trip) => {
    tripsById.set(trip.trip_id, trip);
  });

  const stopTimesByTripId = new Map();
  stopTimes.forEach((row) => {
    if (!tripsById.has(row.trip_id)) return;
    const list = stopTimesByTripId.get(row.trip_id) || [];
    list.push(row);
    stopTimesByTripId.set(row.trip_id, list);
  });

  fs.mkdirSync(outputDir, { recursive: true });

  TARGET_ROUTE_IDS.forEach((routeId) => {
    const routeTrips = targetTrips.filter((trip) => trip.route_id === routeId);
    if (routeTrips.length === 0) return;

    const routeInfo = routesById.get(routeId) || {};
    const result = {
      routeId,
      routeName: routeInfo.route_long_name || "",
      routeShortName: routeInfo.route_short_name || "",
      routeType: routeInfo.route_type || "",
      trips: [],
    };

    routeTrips.forEach((trip) => {
      const tripStopTimes = (stopTimesByTripId.get(trip.trip_id) || []).sort(
        (a, b) =>
          Number.parseInt(a.stop_sequence || "0", 10) -
          Number.parseInt(b.stop_sequence || "0", 10),
      );

      const service = buildServiceDays(calendarByServiceId.get(trip.service_id));
      const stopsForTrip = tripStopTimes.map((stopTime) => {
        const childStop = allStops.get(stopTime.stop_id);
        const parentId = childStop?.parent_station || "";
        const parentStop = parentId ? parentStops.get(parentId) : null;
        const resolvedStop = parentStop || childStop || null;

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

    const outputPath = path.join(outputDir, OUTPUT_FILES[routeId]);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    console.log(`Wrote ${outputPath}`);
  });
}

main();
