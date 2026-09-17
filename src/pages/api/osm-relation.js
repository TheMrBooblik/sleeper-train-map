// pages/api/osm-relation.js
// Fetch OpenStreetMap relation geometry (polyline) for one or more relation IDs.
// Reads from Vercel Blob (daily scrape) when fresh; falls back to Overpass API.
// Supports comma-separated IDs (e.g. "3347914,15014175") to combine segments.

import { getOsmRelation, putOsmRelation, isFresh } from "./lib/file-store.mjs";
import { extractCoordsFromRelation, deduplicateConsecutive } from "./lib/osm-geo.mjs";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function queryOverpass(overpassQuery) {
  let response = null;
  let lastError = null;

  for (const url of OVERPASS_ENDPOINTS) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "train-map/1.0" },
        body: overpassQuery,
      });
      if (response.ok) break;
      console.warn(`[osm-relation] Endpoint ${url} returned ${response.status}, trying next...`);
    } catch (err) {
      lastError = err;
      console.warn(`[osm-relation] Endpoint ${url} failed: ${err.message}`);
    }
  }

  if (!response || !response.ok) {
    const error = new Error("All Overpass API endpoints failed");
    error.status = response?.status || 503;
    error.cause = lastError;
    throw error;
  }

  return response.json();
}

function buildResponse(relationIds, data) {
  const relationMap = new Map();
  for (const el of data.elements || []) {
    if (el.type === "relation") relationMap.set(String(el.id), el);
  }

  const allCoords = [];
  const names = [];

  for (const id of relationIds) {
    const rel = relationMap.get(id);
    if (!rel) {
      console.warn(`[osm-relation] Relation ${id} not found in response, skipping`);
      continue;
    }
    allCoords.push(...extractCoordsFromRelation(rel));
    if (rel.tags?.name) names.push(rel.tags.name);
  }

  const coordinates = deduplicateConsecutive(allCoords);
  const idList = relationIds.join(",");
  const firstRelation = relationMap.get(relationIds[0]);

  return {
    relationId: relationIds.length === 1 ? firstRelation?.id : idList,
    name: names.length === 1 ? names[0] : names.join(" + ") || null,
    coordinates,
    count: coordinates.length,
    tags: relationIds.length === 1 ? (firstRelation?.tags || {}) : {},
  };
}

export default async function handler(req, res) {
  const { relationId } = req.query;

  if (!relationId) {
    return res.status(400).json({ error: "Missing relationId parameter" });
  }

  const relationIds = relationId.split(",").map((id) => id.trim()).filter(Boolean);

  if (relationIds.length === 0) {
    return res.status(400).json({ error: "No valid relation IDs provided" });
  }

  if (relationIds.some((id) => !/^\d+$/.test(id))) {
    return res.status(400).json({ error: "Relation IDs must be numeric" });
  }

  const cacheKey = relationIds.join(",");

  try {
    // Try Vercel Blob first (pre-scraped daily)
    const cached = await getOsmRelation(cacheKey);
    if (cached && isFresh(cached.uploadedAt)) {
      const result = buildResponse(relationIds, cached.data);
      if (result.coordinates.length === 0) {
        return res.status(404).json({ error: "No relations found" });
      }
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json(result);
    }

    // Fall back to Overpass API
    const overpassQuery = `
      [out:json][timeout:30];
      (
        ${relationIds.map((id) => `relation(${id});`).join("\n        ")}
      );
      out geom;
    `;

    const data = await queryOverpass(overpassQuery);

    if (!data.elements || data.elements.length === 0) {
      return res.status(404).json({ error: "No relations found" });
    }

    // Store in Blob for future requests
    await putOsmRelation(cacheKey, data).catch((err) =>
      console.warn("[osm-relation] Blob store failed:", err.message)
    );

    const result = buildResponse(relationIds, data);

    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(result);
  } catch (error) {
    console.error("[osm-relation] Error:", error);
    return res.status(error.status || 500).json({ error: error.message });
  }
}
