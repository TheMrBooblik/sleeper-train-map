import { getGtfsBundleStationNames } from "./lib/file-store";
import { projectStopsToRoutes, stripDeadTripColumns } from "./lib/payload-projection.mjs";
import { resolveInitialPayload, setCacheHeaders } from "./lib/resolve-payload.mjs";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function serviceRunsOnDate(serviceId, date) {
  if (!serviceId) return true;
  const text = String(serviceId).toLowerCase();
  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (yearMatch && Number(yearMatch[1]) !== date.getFullYear()) return false;

  const range = text.match(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\s*-\s*(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (range) {
    const start = new Date(Number(range[1]), Number(range[2]) - 1, Number(range[3]));
    const end = new Date(Number(range[4]), Number(range[5]) - 1, Number(range[6]));
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    if (date < start || date > end) return false;
  }

  if (/\bdaily\b|\bevery day\b|\b7 days\b/.test(text)) {
    const except = text.match(/except\s+(.+)$/);
    if (except) {
      const excluded = DAY_NAMES.some((day, index) => index === date.getDay() &&
        new RegExp(`\\b${day}(?:day)?\\b`).test(except[1]));
      if (excluded) return false;
    }
    return true;
  }

  const weekdayNames = {
    monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6,
    sat: 6, sunday: 0, sun: 0,
  };
  const listed = Object.entries(weekdayNames)
    .filter(([name]) => new RegExp(`\\b${name}\\b`).test(text))
    .map(([, day]) => day);
  return listed.length === 0 || listed.includes(date.getDay());
}

function routeRunsOnDate(route, date) {
  const serviceIds = [route?.service_id_0, route?.service_id_1].filter(Boolean);
  if (serviceIds.length === 0) return true;
  return serviceIds.some((serviceId) => serviceRunsOnDate(serviceId, date));
}

function matchesStation(value, query) {
  return String(value || "").trim().toLowerCase() === String(query || "").trim().toLowerCase();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const date = parseDate(typeof req.query.date === "string" ? req.query.date : "");
  if (!from || !date) return res.status(400).json({ error: "from and date are required" });

  try {
    const { data } = await resolveInitialPayload();
    const projected = stripDeadTripColumns(projectStopsToRoutes(data, getGtfsBundleStationNames()));
    const results = new Map();

    for (const route of Object.values(projected.viewMap ?? {})) {
      if (!route || !routeRunsOnDate(route, date)) continue;
      const directions = [0, 1];
      for (const direction of directions) {
        const origin = route[`origin_trip_${direction}`];
        const destination = route[`destination_trip_${direction}`];
        if (!matchesStation(origin, from) || !destination) continue;
        const key = `${String(destination).toLowerCase()}|${route[`trip_short_name_${direction}`] || route.route_id || ""}`;
        if (results.has(key)) continue;
        results.set(key, {
          destination,
          train: route[`trip_short_name_${direction}`] || route.trip_short_name_0 || "",
          departure: route[`origin_departure_time_${direction}`] || null,
          arrival: route[`destination_arrival_time_${direction}`] || null,
          via: route[`via_${direction}`] || null,
          routeId: route.route_id ?? null,
          agency: route.agency_id || null,
        });
      }
    }

    setCacheHeaders(res);
    return res.status(200).json({ from, date: req.query.date, destinations: [...results.values()] });
  } catch (error) {
    console.error("[plan-destinations] Error:", error);
    return res.status(500).json({ error: "Error finding destinations" });
  }
}
