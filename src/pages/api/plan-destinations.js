import { getGtfsBundleStationNames } from "./lib/file-store";
import { projectStopsToRoutes, stripDeadTripColumns } from "./lib/payload-projection.mjs";
import { resolveInitialPayload, setCacheHeaders } from "./lib/resolve-payload.mjs";

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function matchesStation(value, query) {
  return String(value || "").trim().toLowerCase() === String(query || "").trim().toLowerCase();
}

import { routeRunsOnDate } from "./lib/plan-calendar.mjs";

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
