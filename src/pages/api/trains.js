// pages/api/trains.js
import { isTrain4you } from "../../lib/trainOperatorsFilter";

export default async function handler(req, res) {
  const { type } = req.query;

  const url = `https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/${type}.json`;

  try {
    const response = await fetch(url, {
      headers: {
        "Accept-Encoding": "gzip, deflate, br",
      },
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch ${type}:`,
        response.status,
        response.statusText,
      );
      throw new Error(
        `Failed to fetch data: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type");
    if (
      !contentType ||
      (!contentType.includes("application/json") &&
        !contentType.includes("text/plain"))
    ) {
      console.error(`Invalid content type for ${type}:`, contentType);
      throw new Error(`Invalid content type: ${contentType}`);
    }

    let jsonData = await response.json();

    // Filter out Nightjet and Train4you from Back-on-Track data
    // Nightjet: we use official Nightjet API instead
    // Train4you: don't show stations only with Train4you or its routes
    if (type === "trips") {
      const filtered = {};
      Object.entries(jsonData || {}).forEach(([key, trip]) => {
        const tripName = (
          trip?.trip_short_name ||
          trip?.route_short_name ||
          ""
        ).toString();
        const isNj = /^\s*NJ\s+\d+/.test(tripName);
        const isEn = /^\s*EN\s+\d+/.test(tripName);
        const isT4y = isTrain4you(trip, tripName);
        if (!isNj && !isEn && !isT4y) {
          filtered[key] = trip;
        }
      });
      jsonData = filtered;
    } else if (type === "view_ontd_map") {
      const filtered = {};
      Object.entries(jsonData || {}).forEach(([key, route]) => {
        const trip0 = (route?.trip_short_name_0 || "").toString();
        const trip1 = (route?.trip_short_name_1 || "").toString();
        const isNj = /^\s*NJ\s+\d+/.test(trip0) || /^\s*NJ\s+\d+/.test(trip1);
        const isEn = /^\s*EN\s+\d+/.test(trip0) || /^\s*EN\s+\d+/.test(trip1);
        const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
        if (!isNj && !isEn && !isT4y) {
          filtered[key] = route;
        }
      });
      jsonData = filtered;
    }

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day.
    // This means only ~1 serverless invocation per hour per type, worldwide.
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.setHeader("Content-Type", "application/json");

    res.status(200).json(jsonData);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Error fetching data" });
  }
}
