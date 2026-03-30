// pages/api/scrape-backontrack.js
// Daily cron job: fetches Back-on-Track data + OSM relation geometries and stores in Vercel Blob.
// Vercel injects Authorization: Bearer <CRON_SECRET> automatically for cron invocations.

import polyline from "@mapbox/polyline";
import { putBlobData, putOsmRelation, putNJTrains } from "./lib/blob-store";
import { fetchSingleTrain, fetchNJTrainNumbers, fetchPartnerTrainNumbers } from "./lib/train-fetcher";

const BASE_URL =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// OSM relation IDs used by the frontend (hardcoded in useRoutePaths.js)
const OSM_RELATION_IDS = ["18616102"]; // European Sleeper 453

async function fetchBackontrack(type) {
  const response = await fetch(`${BASE_URL}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!response.ok) throw new Error(`Failed to fetch ${type}: ${response.status}`);
  return response.json();
}

async function fetchOsmRelation(ids) {
  const overpassQuery = `
    [out:json][timeout:30];
    (
      ${ids.map((id) => `relation(${id});`).join("\n      ")}
    );
    out geom;
  `;

  let response = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "train-map/1.0" },
        body: overpassQuery,
      });
      if (response.ok) break;
    } catch {
      // try next endpoint
    }
  }
  if (!response?.ok) throw new Error("All Overpass endpoints failed");
  return response.json();
}

export default async function handler(req, res) {
  const authHeader = req.headers["authorization"];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const errors = [];

  // Fetch Back-on-Track datasets
  const [stops, view_ontd_map, trips] = await Promise.all([
    fetchBackontrack("stops"),
    fetchBackontrack("view_ontd_map"),
    fetchBackontrack("trips"),
  ]);
  // Store stops and trips immediately; view_ontd_map will be enriched with NJ/EN positions below.
  await Promise.all([
    putBlobData("stops", stops),
    putBlobData("trips", trips),
  ]);

  // Fetch and store OSM relation geometries
  for (const id of OSM_RELATION_IDS) {
    try {
      const data = await fetchOsmRelation([id]);
      await putOsmRelation(id, data);
    } catch (err) {
      errors.push({ id, error: err.message });
      console.error(`[scrape-backontrack] OSM relation ${id} failed:`, err.message);
    }
  }

  // Scrape NightJet / EuroNight official API data
  const today = new Date().toISOString().slice(0, 10);
  let njCount = 0;
  try {
    // NJ train numbers from NightJet country-pair API (authoritative — BoT data can be outdated)
    // EN train numbers from NightJet partner endpoint
    const [njNumbers, enNumbers] = await Promise.all([
      fetchNJTrainNumbers(today),
      fetchPartnerTrainNumbers(today),
    ]);

    const allNumbers = [...new Set([...njNumbers, ...enNumbers])];
    const CONCURRENCY = 6;
    const results = {};

    for (let i = 0; i < allNumbers.length; i += CONCURRENCY) {
      const batch = allNumbers.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(batch.map((n) => fetchSingleTrain(n, today)));
      fetched.forEach((train) => {
        if (!train) return;
        // Store the encoded polyline string — much smaller than decoded arrays.
        // Fall back to encoding station coords when the API doesn't provide a polyline.
        const fallbackPositions = train.stations
          .filter((s) => s.location?.latitude && s.location?.longitude)
          .map((s) => [s.location.latitude, s.location.longitude]);
        const encodedPolyline =
          train.polyline ||
          (fallbackPositions.length >= 2 ? polyline.encode(fallbackPositions) : null);
        if (!encodedPolyline) return;
        results[train.lineName] = {
          lineName: train.lineName,
          operator: train.operator,
          polyline: encodedPolyline,
          stations: train.stations,
        };
      });
    }

    await putNJTrains({ uploadedAt: today, trains: results });
    njCount = Object.keys(results).length;

    // Merge NJ/EN positions into view_ontd_map so initial-data can serve pre-enriched data
    Object.values(view_ontd_map).forEach((route) => {
      const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
      for (const name of names) {
        const match = results[name.trim()];
        if (match?.polyline) {
          route.nj_polyline = match.polyline;
          break;
        }
      }
    });
  } catch (err) {
    errors.push({ source: "nightjet", error: err.message });
    console.error("[scrape-backontrack] NightJet scrape failed:", err.message);
  }

  // Store view_ontd_map now — enriched with nj_positions where available
  await putBlobData("view_ontd_map", view_ontd_map);

  const uploadedAt = new Date().toISOString();
  console.log(`[scrape-backontrack] Done at ${uploadedAt}`);

  res.status(200).json({
    ok: true,
    backontrack: ["stops", "view_ontd_map", "trips"],
    osmRelations: OSM_RELATION_IDS,
    nightjet: njCount,
    uploadedAt,
    errors,
  });
}
