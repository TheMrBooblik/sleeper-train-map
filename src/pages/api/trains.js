// pages/api/trains.js
import { enrichStopsData, enrichRoutesData } from "../../lib/uzDataEnricher";
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
      console.log("[API] Filtering out Nightjet and Train4you from trips data");
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
      console.log(
        "[API] Filtered trips (Nightjet + Train4you excluded), remaining:",
        Object.keys(filtered).length,
      );
    } else if (type === "view_ontd_map") {
      // Keep NJ and EN routes — they are used as a fallback while the official
      // NightJet/EuroNight APIs load in the background. The frontend hides them
      // once nightTrainsReady is true. Only Train4you is filtered out.
      console.log(
        "[API] Filtering out Train4you routes from view_ontd_map (NJ/EN kept as fallback)",
      );
      const filtered = {};
      Object.entries(jsonData || {}).forEach(([key, route]) => {
        const trip0 = (route?.trip_short_name_0 || "").toString();
        const trip1 = (route?.trip_short_name_1 || "").toString();
        const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
        if (!isT4y) {
          filtered[key] = route;
        }
      });
      jsonData = filtered;
      console.log(
        "[API] Filtered view_ontd_map (Train4you excluded, NJ/EN kept), remaining:",
        Object.keys(filtered).length,
      );
    }

    // Enrich with manual UZ data if available
    try {
      console.log("[API] Request type:", type);
      if (type === "stops") {
        console.log("[API] Enriching stops data");
        jsonData = await enrichStopsData(jsonData);
      } else if (type === "view_ontd_map") {
        console.log("[API] Enriching view_ontd_map data");
        jsonData = await enrichRoutesData(jsonData);
      }
    } catch (enrichError) {
      console.error("[API] Error enriching data:", enrichError);
      // Continue with non-enriched data
    }

    // Disable caching during development to ensure fresh data
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Content-Type", "application/json");

    res.status(200).json(jsonData);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Error fetching data" });
  }
}
