import { getGtfsBundleStationNames } from "./lib/file-store";
import { projectStopsToRoutes, stripDeadTripColumns } from "./lib/payload-projection.mjs";
import { resolveInitialPayload, setCacheHeaders } from "./lib/resolve-payload.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { data } = await resolveInitialPayload();
    const projected = stripDeadTripColumns(
      projectStopsToRoutes(data, getGtfsBundleStationNames()),
    );

    const stations = new Map();
    for (const stop of projected.stops ?? []) {
      const name = typeof stop?.stop_name === "string" ? stop.stop_name.trim() : "";
      if (!name) continue;

      const id = typeof stop?.stop_id === "string" ? stop.stop_id.trim() : "";
      const key = id || name.toLowerCase();
      if (!stations.has(key)) stations.set(key, { id: id || name, name });
    }

    const result = [...stations.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    setCacheHeaders(res);
    res.status(200).json({ stations: result });
  } catch (error) {
    console.error("[plan-stations] Error:", error);
    res.status(500).json({ error: "Error fetching stations" });
  }
}
