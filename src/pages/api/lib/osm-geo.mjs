// lib/osm-geo.mjs
// Pure helpers for turning Overpass relation responses into coordinate lists.
// Shared by /api/osm-relation (live fallback path) and the scrape-side route
// geometry builder (scripts/lib/route-geometry.mjs) so both assemble polylines
// from OSM relations identically.

// Squared planar distance — enough to compare "which way endpoint is nearest"
// over a single route's span; avoids trig in the O(n^2) stitch loop.
function dist2(a, b) {
  const dLat = a[0] - b[0];
  const dLon = a[1] - b[1];
  return dLat * dLat + dLon * dLon;
}

const endpointKey = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

/**
 * Stitch a relation's member ways into one connected, ordered path.
 *
 * OSM route relations do NOT guarantee their member ways are listed in travel
 * order, so concatenating them as-is jumps between non-adjacent ways — straight
 * lines slashing across the map (e.g. European Sleeper 453 around Stendal). We
 * chain ways end-to-end instead: begin at a route terminus (an endpoint no other
 * way shares), then repeatedly append the remaining way whose nearest end
 * continues the path, flipping it when needed. O(n^2) over a relation's ways,
 * which only runs on a cache miss.
 *
 * @param {Array<Array<[number, number]>>} ways one coordinate list per member way
 * @returns {Array<[number, number]>}
 */
export function stitchWays(ways) {
  const segs = (ways || []).filter((w) => Array.isArray(w) && w.length >= 2);
  if (segs.length <= 1) return segs[0] ? segs[0].slice() : [];

  // A terminus is an endpoint touched by exactly one way; starting there lets a
  // linear route chain in a single pass instead of from some interior way.
  const endpointCount = new Map();
  const bump = (k) => endpointCount.set(k, (endpointCount.get(k) || 0) + 1);
  for (const w of segs) {
    bump(endpointKey(w[0]));
    bump(endpointKey(w[w.length - 1]));
  }
  let startIdx = 0;
  let startFlip = false;
  for (let i = 0; i < segs.length; i++) {
    if (endpointCount.get(endpointKey(segs[i][0])) === 1) {
      startIdx = i;
      startFlip = false;
      break;
    }
    if (endpointCount.get(endpointKey(segs[i][segs[i].length - 1])) === 1) {
      startIdx = i;
      startFlip = true;
      break;
    }
  }

  const used = new Array(segs.length).fill(false);
  used[startIdx] = true;
  const result = startFlip ? segs[startIdx].slice().reverse() : segs[startIdx].slice();

  for (let n = 1; n < segs.length; n++) {
    const tail = result[result.length - 1];
    let best = -1;
    let bestFlip = false;
    let bestD = Infinity;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const seg = segs[i];
      const dStart = dist2(tail, seg[0]);
      if (dStart < bestD) {
        bestD = dStart;
        best = i;
        bestFlip = false;
      }
      const dEnd = dist2(tail, seg[seg.length - 1]);
      if (dEnd < bestD) {
        bestD = dEnd;
        best = i;
        bestFlip = true;
      }
    }
    if (best === -1) break;
    used[best] = true;
    const seg = bestFlip ? segs[best].slice().reverse() : segs[best];
    // Drop the shared joint vertex when consecutive ways actually meet.
    if (endpointKey(result[result.length - 1]) === endpointKey(seg[0])) {
      result.push(...seg.slice(1));
    } else {
      result.push(...seg);
    }
  }
  return result;
}

export function extractCoordsFromRelation(relation) {
  if (!relation || !relation.members) return [];
  const ways = relation.members
    .filter((m) => m.type === "way" && !m.role && Array.isArray(m.geometry))
    .map((member) =>
      member.geometry
        .filter((point) => point && point.lat != null && point.lon != null)
        .map((point) => [point.lat, point.lon]),
    )
    .filter((coords) => coords.length >= 2);
  return stitchWays(ways);
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
