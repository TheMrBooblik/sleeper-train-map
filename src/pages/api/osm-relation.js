// pages/api/osm-relation.js
// Fetch OpenStreetMap relation geometry (polyline) for one or more relation IDs.
// Supports comma-separated IDs (e.g. "3347914,15014175") to combine multiple
// relations into a single polyline — useful for routes that span several segments.

// Multiple Overpass API instances to try in order (the primary one can time out)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/**
 * Run an Overpass query, trying each endpoint until one succeeds.
 * Returns parsed JSON data or throws on failure.
 */
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
    const status = response?.status || 503;
    const error = new Error("All Overpass API endpoints failed");
    error.status = status;
    error.cause = lastError;
    throw error;
  }

  return response.json();
}

/**
 * Extract ordered [lat, lon] coordinates from a single relation element.
 * Uses the inline geometry from `out geom;` on way members.
 */
function extractCoordsFromRelation(relation) {
  const coords = [];
  if (!relation.members) return coords;

  const wayMembers = relation.members.filter((m) => m.type === "way");
  wayMembers.forEach((member) => {
    if (member.geometry && Array.isArray(member.geometry)) {
      member.geometry.forEach((point) => {
        if (point.lat && point.lon) {
          coords.push([point.lat, point.lon]);
        }
      });
    }
  });
  return coords;
}

/**
 * Remove duplicate consecutive coordinates from the list.
 */
function deduplicateConsecutive(coords) {
  const result = [];
  let prev = null;
  for (const coord of coords) {
    if (!prev || prev[0] !== coord[0] || prev[1] !== coord[1]) {
      result.push(coord);
      prev = coord;
    }
  }
  return result;
}

export default async function handler(req, res) {
  const { relationId } = req.query;

  if (!relationId) {
    return res.status(400).json({ error: "Missing relationId parameter" });
  }

  // Support comma-separated relation IDs for combining multiple segments
  const relationIds = relationId.split(",").map((id) => id.trim()).filter(Boolean);

  if (relationIds.length === 0) {
    return res.status(400).json({ error: "No valid relation IDs provided" });
  }

  // Validate all IDs are numeric (prevent injection into Overpass query)
  if (relationIds.some((id) => !/^\d+$/.test(id))) {
    return res.status(400).json({ error: "Relation IDs must be numeric" });
  }

  try {
    // Fetch all relations in a single Overpass query
    const idList = relationIds.join(",");
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

    // Build a map of id -> relation element for ordered processing
    const relationMap = new Map();
    for (const el of data.elements) {
      if (el.type === "relation") {
        relationMap.set(String(el.id), el);
      }
    }

    // Extract and concatenate coordinates in the order the IDs were provided.
    // This lets callers control segment ordering (e.g. Praha-Košice first, then Košice-Humenné).
    const allCoords = [];
    const names = [];

    for (const id of relationIds) {
      const rel = relationMap.get(id);
      if (!rel) {
        console.warn(`[osm-relation] Relation ${id} not found in response, skipping`);
        continue;
      }
      const coords = extractCoordsFromRelation(rel);
      allCoords.push(...coords);
      if (rel.tags?.name) names.push(rel.tags.name);
    }

    const uniqueCoords = deduplicateConsecutive(allCoords);

    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 1 day
    res.setHeader("Content-Type", "application/json");

    // For single relations, keep the same response shape as before (backward compatible).
    // For multiple, return combined data.
    const firstRelation = relationMap.get(relationIds[0]);
    return res.status(200).json({
      relationId: relationIds.length === 1 ? firstRelation?.id : idList,
      name: names.length === 1 ? names[0] : names.join(" + ") || null,
      coordinates: uniqueCoords,
      count: uniqueCoords.length,
      tags: relationIds.length === 1 ? (firstRelation?.tags || {}) : {},
    });
  } catch (error) {
    console.error("[osm-relation] Error:", error);
    const status = error.status || 500;
    return res.status(status).json({ error: error.message });
  }
}
