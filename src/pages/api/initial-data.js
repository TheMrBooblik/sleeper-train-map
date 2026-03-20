// pages/api/initial-data.js
// Combined endpoint: returns stops + viewMap + trips in one response.
// Vercel CDN caches this for 1 hour so only ~1 serverless invocation per hour worldwide.

import { isTrain4you } from "../../lib/trainOperatorsFilter";

const BASE_URL =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

/**
 * Fetch a single Back-on-Track data type from GitHub.
 */
async function fetchType(type) {
  const response = await fetch(`${BASE_URL}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${type}: ${response.status}`);
  }
  return response.json();
}

/**
 * Filter out Train4you from trips data.
 * NJ/EN are kept here so they render as Back-on-Track routes initially;
 * the client filters them out once official NightJet/EuroNight data loads.
 */
function filterTrips(data) {
  const filtered = {};
  Object.entries(data || {}).forEach(([key, trip]) => {
    const tripName = (
      trip?.trip_short_name ||
      trip?.route_short_name ||
      ""
    ).toString();
    const isT4y = isTrain4you(trip, tripName);
    if (!isT4y) {
      filtered[key] = trip;
    }
  });
  return filtered;
}

/**
 * Filter out Train4you from view_ontd_map data.
 * NJ/EN are kept here so they render as Back-on-Track routes initially;
 * the client filters them out once official NightJet/EuroNight data loads.
 */
function filterViewMap(data) {
  const filtered = {};
  Object.entries(data || {}).forEach(([key, route]) => {
    const trip0 = (route?.trip_short_name_0 || "").toString();
    const trip1 = (route?.trip_short_name_1 || "").toString();
    const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
    if (!isT4y) {
      filtered[key] = route;
    }
  });
  return filtered;
}

export default async function handler(req, res) {
  try {
    // Fetch all three types from GitHub in parallel
    const [rawStops, rawViewMap, rawTrips] = await Promise.all([
      fetchType("stops"),
      fetchType("view_ontd_map"),
      fetchType("trips"),
    ]);

    // Apply operator filtering
    const filteredTrips = filterTrips(rawTrips);
    const filteredViewMap = filterViewMap(rawViewMap);

    let stops = rawStops;
    let viewMap = filteredViewMap;

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.setHeader("Content-Type", "application/json");

    res.status(200).json({
      stops,
      viewMap,
      trips: filteredTrips,
    });
  } catch (error) {
    console.error("[initial-data] Error:", error);
    res.status(500).json({ error: "Error fetching initial data" });
  }
}
