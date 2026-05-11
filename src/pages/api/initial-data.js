// pages/api/initial-data.js
// Combined endpoint: returns stops + viewMap + trips in one response.
// Reads from Vercel Blob (daily scrape) when fresh; falls back to GitHub.
// Vercel CDN caches this for 1 hour so only ~1 serverless invocation per hour worldwide.

import { isTrain4you } from "../../lib/trainOperatorsFilter";
import { getBlobData, getNJTrains, getChineseTrains, isFresh } from "./lib/file-store";
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
    const [blobStops, blobViewMap, blobTrips, njBlob, crBlob] = await Promise.all([
      getBlobData("stops"),
      getBlobData("view_ontd_map"),
      getBlobData("trips"),
      getNJTrains(),
      getChineseTrains(),
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

    // Normalize stops shape early.
    const stopsArray = Array.isArray(rawStops)
      ? rawStops
      : Object.values(rawStops || {});
    const trimmedStops = stopsArray.map((s) => ({
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: s.stop_lat,
      stop_lon: s.stop_lon,
    }));

    // Add NJ stations to stops (by exact name) so synthetic routes reference NJ names
    // backed by NJ coordinates.
    const njTrains = njBlob?.data?.trains ?? {};
    const njStationsByName = new Map();
    Object.values(njTrains).forEach((train) => {
      (train.stations ?? []).forEach((s) => {
        if (
          s?.name &&
          Number.isFinite(s?.location?.latitude) &&
          Number.isFinite(s?.location?.longitude) &&
          !njStationsByName.has(s.name)
        ) {
          njStationsByName.set(s.name, s);
        }
      });
    });
    const botStopNameSet = new Set(
      trimmedStops.map((s) => (s.stop_id || "").toLowerCase()),
    );
    njStationsByName.forEach((njStation) => {
      if (botStopNameSet.has(njStation.name.toLowerCase())) return;
      trimmedStops.push({
        stop_id: njStation.name,
        stop_name: njStation.name,
        stop_lat: njStation.location.latitude,
        stop_lon: njStation.location.longitude,
      });
      botStopNameSet.add(njStation.name.toLowerCase());
    });

    // Remove BoT entries for any NJ/EN train that has NJ API data.
    // BoT's station lists are stale (wrong routing, wrong stop names for current timetables).
    // Synthetic routes built below use accurate NJ API station names directly.
    const njApiTrainNumbers = new Set(Object.keys(njTrains));
    Object.keys(filteredViewMap).forEach((key) => {
      const route = filteredViewMap[key];
      const t0 = (route?.trip_short_name_0 || "").trim();
      const t1 = (route?.trip_short_name_1 || "").trim();
      if (njApiTrainNumbers.has(t0) || njApiTrainNumbers.has(t1)) {
        delete filteredViewMap[key];
      }
    });

    // Synthetic routes for all NJ/EN trains (BoT entries for them were removed above)
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
      const origin = data.stations[0].name;
      const dest = data.stations[data.stations.length - 1].name;
      const reversePair = unmatchedNJ.find(
        ([k, v]) =>
          k !== lineName &&
          !syntheticPaired.has(k) &&
          v.stations?.[0]?.name === dest &&
          v.stations?.[v.stations.length - 1]?.name === origin,
      );
      const safeId = lineName.replace(/\s+/g, "_");
      const entry = {
        route_id: `nj_standalone_${safeId}`,
        // Empty agency_id was mapped to gray on the map; ÖBB matches BoT NightJet rows and TrainDetailPanel.
        agency_id: "ÖBB",
        trip_short_name_0: lineName,
        origin_trip_0: origin,
        destination_trip_0: dest,
        via_0: data.stations
          .slice(1, -1)
          .map((s) => s.name)
          .filter(Boolean)
          .join(" - "),
        route_long_name: `${origin} – ${dest}`,
        nj_polyline: data.polyline,
        is_active: "Y",
      };
      if (reversePair) {
        const [revName, revData] = reversePair;
        entry.trip_short_name_1 = revName;
        entry.origin_trip_1 = revData.stations[0].name;
        entry.destination_trip_1 =
          revData.stations[revData.stations.length - 1].name;
        entry.via_1 = revData.stations
          .slice(1, -1)
          .map((s) => s.name)
          .filter(Boolean)
          .join(" - ");
        syntheticPaired.add(revName);
      }
      syntheticPaired.add(lineName);
      filteredViewMap[entry.route_id] = entry;
    });

    // ── Chinese Railway (CR) ──────────────────────────────────────────────
    const crTrains = crBlob?.data?.trains ?? {};

    // Add CR stations to stops so markers appear on the map
    const crStopNameSet = new Set(botStopNameSet);
    Object.values(crTrains).forEach((train) => {
      (train.stations ?? []).forEach((s) => {
        if (
          !s?.name ||
          !Number.isFinite(s?.location?.latitude) ||
          !Number.isFinite(s?.location?.longitude)
        ) return;
        if (crStopNameSet.has(s.name.toLowerCase())) return;
        trimmedStops.push({
          stop_id: s.name,
          stop_name: s.name,
          stop_lat: s.location.latitude,
          stop_lon: s.location.longitude,
        });
        crStopNameSet.add(s.name.toLowerCase());
        botStopNameSet.add(s.name.toLowerCase());
      });
    });

    // Synthetic viewMap entries for CR trains (same pairing logic as NJ)
    const crTrainList = Object.entries(crTrains).filter(
      ([, data]) => data.polyline && data.stations?.length >= 2,
    );
    const crPaired = new Set();
    crTrainList.forEach(([lineName, data]) => {
      if (crPaired.has(lineName)) return;
      const origin = data.stations[0].name;
      const dest = data.stations[data.stations.length - 1].name;
      const reversePair = crTrainList.find(
        ([k, v]) =>
          k !== lineName &&
          !crPaired.has(k) &&
          v.stations?.[0]?.name === dest &&
          v.stations?.[v.stations.length - 1]?.name === origin,
      );
      const safeId = lineName.replace(/\s+/g, "_");
      const entry = {
        route_id: `cr_${safeId}`,
        agency_id: "CR",
        trip_short_name_0: lineName,
        origin_trip_0: origin,
        destination_trip_0: dest,
        via_0: data.stations
          .slice(1, -1)
          .map((s) => s.name)
          .filter(Boolean)
          .join(" - "),
        route_long_name: `${origin} – ${dest}`,
        nj_polyline: data.polyline,
        is_active: "Y",
      };
      if (reversePair) {
        const [revName, revData] = reversePair;
        entry.trip_short_name_1 = revName;
        entry.origin_trip_1 = revData.stations[0].name;
        entry.destination_trip_1 =
          revData.stations[revData.stations.length - 1].name;
        entry.via_1 = revData.stations
          .slice(1, -1)
          .map((s) => s.name)
          .filter(Boolean)
          .join(" - ");
        crPaired.add(revName);
      }
      crPaired.add(lineName);
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
