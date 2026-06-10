// scripts/adapters/osm.mjs
// OSM relation geometries via Overpass. One cached file per relation id;
// failures are per-relation (one bad relation doesn't block the others).

import { OVERPASS_ENDPOINTS } from "../lib/scrape-helpers.mjs";

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

export async function run(entry, ctx) {
  const relationIds = entry.params?.relationIds ?? [];
  for (const id of relationIds) {
    try {
      const data = await fetchOsmRelation([id]);
      ctx.write(`osm-${id}.json`, data);
    } catch (err) {
      ctx.errors.push({ id, error: err.message });
      console.error(`[scrape] OSM ${id} failed: ${err.message}`);
    }
  }
}
