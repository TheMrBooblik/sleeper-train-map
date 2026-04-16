// pages/api/initial-data.js
// Combined endpoint: returns stops + viewMap + trips in one response.
// Reads from Vercel Blob (daily scrape) when fresh; falls back to GitHub.
// Vercel CDN caches this for 1 hour so only ~1 serverless invocation per hour worldwide.

import { isTrain4you } from "../../lib/trainOperatorsFilter";
import { getBlobData, getNJTrains, isFresh } from "./lib/blob-store";
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
    const [blobStops, blobViewMap, blobTrips, njBlob] = await Promise.all([
      getBlobData("stops"),
      getBlobData("view_ontd_map"),
      getBlobData("trips"),
      getNJTrains(),
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

    // Normalize stops shape early so we can use them for NJ station → BoT stop matching.
    // This is important for synthetic NJ-only routes: NightJet API sometimes provides
    // only English station names (e.g. "Vienna Central Station"), which won't match
    // Back-on-Track stop names ("Wien Hbf") on the client.
    const stopsArray = Array.isArray(rawStops)
      ? rawStops
      : Object.values(rawStops || {});
    const trimmedStops = stopsArray.map((s) => ({
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: s.stop_lat,
      stop_lon: s.stop_lon,
    }));
    const parseCoord = (v) => {
      const n = typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
      return Number.isFinite(n) ? n : null;
    };
    const stopPoints = trimmedStops
      .map((s) => ({
        name: s.stop_name || s.stop_id,
        lat: parseCoord(s.stop_lat),
        lon: parseCoord(s.stop_lon),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.name);
    const resolveBotStopName = (station) => {
      const lat = station?.location?.latitude;
      const lon = station?.location?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return station?.name;
      let best = null;
      let bestD2 = Infinity;
      for (const p of stopPoints) {
        const dLat = p.lat - lat;
        const dLon = p.lon - lon;
        const d2 = dLat * dLat + dLon * dLon;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
      // Rough threshold: ~0.03 degrees ≈ 3km-ish (varies by latitude). Keeps us from
      // accidentally snapping to a different city when data is imperfect.
      return best && bestD2 <= 0.03 * 0.03 ? best.name : station?.name;
    };

    // Synthetic routes for NJ partner trains with no Back-on-Track entry (e.g. EN 40416/40417)
    const njTrains = njBlob?.data?.trains ?? {};
    const botMatchedNJNumbers = new Set();
    Object.values(filteredViewMap).forEach((route) => {
      [route.trip_short_name_0, route.trip_short_name_1]
        .filter(Boolean)
        .forEach((n) => botMatchedNJNumbers.add(n.trim()));
    });
    const unmatchedNJ = Object.entries(njTrains).filter(
      ([lineName, data]) =>
        !botMatchedNJNumbers.has(lineName) &&
        data.polyline &&
        data.stations?.length >= 2,
    );
    const syntheticPaired = new Set();
    unmatchedNJ.forEach(([lineName, data]) => {
      if (syntheticPaired.has(lineName)) return;
      const origin = resolveBotStopName(data.stations[0]);
      const dest = resolveBotStopName(data.stations[data.stations.length - 1]);
      const reversePair = unmatchedNJ.find(
        ([k, v]) =>
          k !== lineName &&
          !syntheticPaired.has(k) &&
          resolveBotStopName(v.stations?.[0]) === dest &&
          resolveBotStopName(v.stations?.[v.stations.length - 1]) === origin,
      );
      const safeId = lineName.replace(/\s+/g, "_");
      const entry = {
        route_id: `nj_standalone_${safeId}`,
        agency_id: "",
        trip_short_name_0: lineName,
        origin_trip_0: origin,
        destination_trip_0: dest,
        via_0: data.stations
          .slice(1, -1)
          .map((s) => resolveBotStopName(s))
          .filter(Boolean)
          .join(" - "),
        route_long_name: `${origin} – ${dest}`,
        nj_polyline: data.polyline,
        is_active: "Y",
      };
      if (reversePair) {
        const [revName, revData] = reversePair;
        entry.trip_short_name_1 = revName;
        entry.origin_trip_1 = resolveBotStopName(revData.stations[0]);
        entry.destination_trip_1 = resolveBotStopName(
          revData.stations[revData.stations.length - 1],
        );
        entry.via_1 = revData.stations
          .slice(1, -1)
          .map((s) => resolveBotStopName(s))
          .filter(Boolean)
          .join(" - ");
        syntheticPaired.add(revName);
      }
      syntheticPaired.add(lineName);
      filteredViewMap[entry.route_id] = entry;
    });

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.setHeader("Content-Type", "application/json");

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
