// pages/api/trains.js
// Proxies Back-on-Track data by type.
// Reads from Vercel Blob (daily scrape) when fresh; falls back to GitHub.

import { isTrain4you } from "../../lib/trainOperatorsFilter";
import { getBlobData, isFresh } from "./lib/file-store";

const BLOB_SUPPORTED_TYPES = ["stops", "view_ontd_map", "trips"];

function isActiveRecord(record) {
  return (record?.is_active || "Y").toString().toUpperCase() !== "N";
}

// trips.json is per-trip is_active; view_ontd_map rows often omit it.
// Hide a map row when trips reference its route_id but no trip survives filtering (all inactive, etc.).

/** @param {Record<string, object>} trips */
export function routeIdsReferencedInTrips(trips) {
  const ids = new Set();
  for (const t of Object.values(trips || {})) {
    if (t?.route_id != null) ids.add(String(t.route_id));
  }
  return ids;
}

/** @param {Record<string, object>} filteredTrips — already filtered (active, operators, …) */
export function routeIdsFromFilteredTrips(filteredTrips) {
  const ids = new Set();
  for (const t of Object.values(filteredTrips || {})) {
    if (t?.route_id != null) ids.add(String(t.route_id));
  }
  return ids;
}

/**
 * Drop map rows for routes that still appear in raw trips but have zero trips left after filtering.
 * Orphan routes (no trip row with that route_id) stay visible.
 */
export function keepViewMapRowForTripActivity(
  routeRowAllowed,
  routeId,
  referencedIds,
  visibleIds,
) {
  if (!routeRowAllowed) return false;
  if (routeId == null) return true;
  const rid = String(routeId);
  if (!referencedIds.has(rid)) return true;
  return visibleIds.has(rid);
}

/** Same rules as the trips response: inactive + NJ/EN/T4y removed. */
function filterTripsTrainsResponse(data) {
  const filtered = {};
  Object.entries(data || {}).forEach(([key, trip]) => {
    if (!isActiveRecord(trip)) return;
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
  return filtered;
}

async function loadJsonType(type) {
  if (BLOB_SUPPORTED_TYPES.includes(type)) {
    const blob = await getBlobData(type);
    if (blob && isFresh(blob.uploadedAt)) {
      return blob.data;
    }
  }
  const url = `https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/${type}.json`;
  const response = await fetch(url, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!response.ok) {
    console.error(`Failed to fetch ${type}:`, response.status, response.statusText);
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
  return response.json();
}

export default async function handler(req, res) {
  const { type } = req.query;

  try {
    let jsonData;

    if (type === "view_ontd_map") {
      const [viewMap, rawTrips] = await Promise.all([
        loadJsonType("view_ontd_map"),
        loadJsonType("trips"),
      ]);
      jsonData = viewMap;
      const filteredTrips = filterTripsTrainsResponse(rawTrips);
      const referencedIds = routeIdsReferencedInTrips(rawTrips);
      const visibleIds = routeIdsFromFilteredTrips(filteredTrips);
      const filtered = {};
      Object.entries(jsonData || {}).forEach(([key, route]) => {
        if (!isActiveRecord(route)) return;
        const trip0 = (route?.trip_short_name_0 || "").toString();
        const trip1 = (route?.trip_short_name_1 || "").toString();
        const isNj = /^\s*NJ\s+\d+/.test(trip0) || /^\s*NJ\s+\d+/.test(trip1);
        const isEn = /^\s*EN\s+\d+/.test(trip0) || /^\s*EN\s+\d+/.test(trip1);
        const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
        const rowOk = !isNj && !isEn && !isT4y;
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
      jsonData = filtered;
    } else {
      jsonData = await loadJsonType(type);

      // Filter out Nightjet and Train4you from Back-on-Track data
      // Nightjet: we use official Nightjet API instead
      // Train4you: don't show stations only with Train4you or its routes
      if (type === "trips") {
        jsonData = filterTripsTrainsResponse(jsonData);
      }
    }

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day.
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
