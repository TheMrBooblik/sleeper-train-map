// lib/osm-geo.mjs
// Pure helpers for turning Overpass relation responses into coordinate lists.
// Shared by /api/osm-relation (live fallback path) and the scrape-side route
// geometry builder (scripts/lib/route-geometry.mjs) so both assemble polylines
// from OSM relations identically.

export function extractCoordsFromRelation(relation) {
  const coords = [];
  if (!relation.members) return coords;
  relation.members
    .filter((m) => m.type === "way" && !m.role)
    .forEach((member) => {
      if (Array.isArray(member.geometry)) {
        member.geometry.forEach((point) => {
          if (point.lat && point.lon) coords.push([point.lat, point.lon]);
        });
      }
    });
  return coords;
}

export function deduplicateConsecutive(coords) {
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

/**
 * Deduplicated [lat, lon] list for one relation id inside a raw Overpass
 * `out geom;` response ({ elements: [...] }). Returns [] when absent.
 */
export function relationCoordsFromOverpass(data, relationId) {
  const rel = (data?.elements ?? []).find(
    (el) => el.type === "relation" && String(el.id) === String(relationId),
  );
  return rel ? deduplicateConsecutive(extractCoordsFromRelation(rel)) : [];
}
