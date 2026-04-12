// pages/api/initial-data.js
// Combined endpoint: returns stops + viewMap + trips in one response.
// Reads from Vercel Blob (daily scrape) when fresh; falls back to GitHub.
// Vercel CDN caches this for 1 hour so only ~1 serverless invocation per hour worldwide.

import { isTrain4you } from "../../lib/trainOperatorsFilter";
import { getBlobData, isFresh } from "./lib/blob-store";
import {
  keepViewMapRowForTripActivity,
  routeIdsFromFilteredTrips,
  routeIdsReferencedInTrips,
} from "./trains";

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

function isActiveRecord(record) {
  return (record?.is_active || "Y").toString().toUpperCase() !== "N";
}

/**
 * Filter out Train4you from trips data.
 * NJ/EN are kept here so they render as Back-on-Track routes initially;
 * the client filters them out once official NightJet/EuroNight data loads.
 */
function filterTrips(data) {
  const filtered = {};
  Object.entries(data || {}).forEach(([key, trip]) => {
    if (!isActiveRecord(trip)) return;
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
/**
 * view_ontd_map rows often lack is_active; trips.json is authoritative per service.
 * If every trip for route_id is inactive (filtered out), hide the map row.
 */
function filterViewMap(data, rawTrips, filteredTrips) {
  const referencedIds = routeIdsReferencedInTrips(rawTrips);
  const visibleIds = routeIdsFromFilteredTrips(filteredTrips);
  const filtered = {};
  Object.entries(data || {}).forEach(([key, route]) => {
    if (!isActiveRecord(route)) return;
    const trip0 = (route?.trip_short_name_0 || "").toString();
    const trip1 = (route?.trip_short_name_1 || "").toString();
    const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
    const rowOk = !isT4y;
    if (
      !keepViewMapRowForTripActivity(
        rowOk,
        route?.route_id,
        referencedIds,
        visibleIds,
      )
    ) {
      return;
    }
    filtered[key] = route;
  });
  return filtered;
}

export default async function handler(req, res) {
  try {
    let rawStops, rawViewMap, rawTrips;
    let source = "github";

    // Try Vercel Blob first (daily scrape — view_ontd_map already has nj_positions merged in)
    const [blobStops, blobViewMap, blobTrips] = await Promise.all([
      getBlobData("stops"),
      getBlobData("view_ontd_map"),
      getBlobData("trips"),
    ]);

    if (
      blobStops && isFresh(blobStops.uploadedAt) &&
      blobViewMap && isFresh(blobViewMap.uploadedAt) &&
      blobTrips && isFresh(blobTrips.uploadedAt)
    ) {
      rawStops = blobStops.data;
      rawViewMap = blobViewMap.data;
      rawTrips = blobTrips.data;
      source = "blob";
    } else {
      // Fall back to GitHub (no NJ positions — scrape hasn't run yet)
      [rawStops, rawViewMap, rawTrips] = await Promise.all([
        fetchType("stops"),
        fetchType("view_ontd_map"),
        fetchType("trips"),
      ]);
    }

    console.log(`[initial-data] source: ${source}`);

    // Apply operator filtering
    const filteredTrips = filterTrips(rawTrips);
    const filteredViewMap = filterViewMap(rawViewMap, rawTrips, filteredTrips);

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.setHeader("Content-Type", "application/json");

    // Strip stops to only the fields the client needs (name + coords) — raw BoT stops
    // have 17 fields and 28k+ entries which bloats the response to 11MB+.
    const stopsArray = Array.isArray(rawStops)
      ? rawStops
      : Object.values(rawStops || {});
    const trimmedStops = stopsArray.map((s) => ({
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: s.stop_lat,
      stop_lon: s.stop_lon,
    }));

    res.status(200).json({
      stops: trimmedStops,
      viewMap: filteredViewMap,
      trips: filteredTrips,
    });
  } catch (error) {
    console.error("[initial-data] Error:", error);
    res.status(500).json({ error: "Error fetching initial data" });
  }
}
