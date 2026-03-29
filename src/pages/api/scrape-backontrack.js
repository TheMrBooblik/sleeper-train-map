// pages/api/scrape-backontrack.js
// Daily cron job: fetches Back-on-Track data + OSM relation geometries and stores in Vercel Blob.
// Vercel injects Authorization: Bearer <CRON_SECRET> automatically for cron invocations.

import { putBlobData, putOsmRelation } from "./lib/blob-store";

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

  // Fetch and store Back-on-Track datasets
  const botKeys = ["stops", "view_ontd_map", "trips"];
  const [stops, view_ontd_map, trips] = await Promise.all(botKeys.map(fetchBackontrack));
  await Promise.all([
    putBlobData("stops", stops),
    putBlobData("view_ontd_map", view_ontd_map),
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

  const uploadedAt = new Date().toISOString();
  console.log(`[scrape-backontrack] Done at ${uploadedAt}`);

  res.status(200).json({
    ok: true,
    backontrack: botKeys,
    osmRelations: OSM_RELATION_IDS,
    uploadedAt,
    errors,
  });
}
