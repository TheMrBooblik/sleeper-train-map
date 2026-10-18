// scripts/lib/rail-graph.mjs
// A track graph and a shortest-path router over it, for drawing a train along
// real track between two stations when no source sends the line itself.
//
// Built from polylines of track — OpenStreetMap's railway ways (which share
// their junction nodes exactly) or a feed's shapes (which overlap without
// sharing a vertex). Vertices are snapped to a ~11 m grid so coinciding points
// become one node, and nodes of different polylines within `joinMeters` are
// linked, which is what turns overlapping shapes into a network with
// junctions. A route is Dijkstra over track distance from the node nearest
// one station to the node nearest the next; it is refused when either station
// is farther than `maxSnapKm` from any track, or when the track route is
// implausibly long against the straight line (a detour the train does not
// take is worse than no line).
//
// Dependency-free and pure. Covered by tests/verify-srt.mjs.

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function km([lat1, lon1], [lat2, lon2]) {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const SNAP = 1e4; // 1e-4° ≈ 11 m
const JOIN_CELL = 0.001; // ≈ 110 m buckets for linking nearby nodes
const INDEX_CELL = 0.05; // ≈ 5.5 km buckets for finding the node nearest a station

/**
 * @param {[number, number][][]} paths track polylines, [lat, lon]
 * @param {{ joinMeters?: number }} [opts]
 */
export function buildRailGraph(paths, { joinMeters = 120 } = {}) {
  const ids = new Map();
  const coords = [];
  const adj = [];
  const node = ([lat, lon]) => {
    const key = `${Math.round(lat * SNAP)},${Math.round(lon * SNAP)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = coords.length;
      ids.set(key, id);
      coords.push([lat, lon]);
      adj.push([]);
    }
    return id;
  };
  const link = (a, b, w) => {
    if (a === b) return;
    adj[a].push(b, w);
    adj[b].push(a, w);
  };
  for (const path of paths) {
    if (!Array.isArray(path) || path.length < 2) continue;
    let prev = node(path[0]);
    for (let i = 1; i < path.length; i++) {
      const cur = node(path[i]);
      link(prev, cur, km(coords[prev], coords[cur]));
      prev = cur;
    }
  }
  // Junctions between polylines that overlap without sharing a vertex.
  if (joinMeters > 0) {
    const cells = new Map();
    const cellOf = ([lat, lon]) => [Math.floor(lat / JOIN_CELL), Math.floor(lon / JOIN_CELL)];
    coords.forEach((c, id) => {
      const [y, x] = cellOf(c);
      const k = `${y},${x}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(id);
    });
    const limit = joinMeters / 1000;
    coords.forEach((c, id) => {
      const [y, x] = cellOf(c);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const other of cells.get(`${y + dy},${x + dx}`) ?? []) {
            if (other <= id) continue;
            const d = km(c, coords[other]);
            if (d <= limit) link(id, other, d);
          }
        }
      }
    });
  }
  // A coarse index for nearestNode: ~5.5 km cells.
  const index = new Map();
  coords.forEach(([lat, lon], id) => {
    const k = `${Math.floor(lat / INDEX_CELL)},${Math.floor(lon / INDEX_CELL)}`;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(id);
  });
  return { coords, adj, index, size: coords.length };
}

/** The graph node nearest a point, and how far it is. */
export function nearestNode(graph, point, rings = 2) {
  let best = -1;
  let bestKm = Infinity;
  const [lat, lon] = point;
  const y = Math.floor(lat / INDEX_CELL);
  const x = Math.floor(lon / INDEX_CELL);
  for (let dy = -rings; dy <= rings; dy++) {
    for (let dx = -rings; dx <= rings; dx++) {
      for (const i of graph.index.get(`${y + dy},${x + dx}`) ?? []) {
        const d = km(point, graph.coords[i]);
        if (d < bestKm) {
          bestKm = d;
          best = i;
        }
      }
    }
  }
  return { id: best, km: bestKm };
}

/** Binary-heap Dijkstra from `from` to `to`; the node path, or null. */
function shortestPath(graph, from, to, maxKm) {
  const dist = new Float64Array(graph.size).fill(Infinity);
  const prev = new Int32Array(graph.size).fill(-1);
  const heap = [[0, from]];
  dist[from] = 0;
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (u === to) break;
    if (d > maxKm) return null;
    const edges = graph.adj[u];
    for (let k = 0; k < edges.length; k += 2) {
      const v = edges[k];
      const nd = d + edges[k + 1];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        push([nd, v]);
      }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const out = [];
  for (let v = to; v !== -1; v = prev[v]) out.push(v);
  return { nodes: out.reverse(), km: dist[to] };
}

/**
 * Track between two stations: [lat, lon][] starting at `a` and ending at `b`
 * (the stations themselves are the first and last vertex, so a stop always
 * sits on its own line), or null.
 */
export function routeBetween(graph, a, b, { maxSnapKm = 8, maxDetour = 2.2, slackKm = 40 } = {}) {
  if (!graph?.size) return null;
  const na = nearestNode(graph, a);
  const nb = nearestNode(graph, b);
  if (na.id < 0 || nb.id < 0 || na.km > maxSnapKm || nb.km > maxSnapKm) return null;
  const straight = km(a, b);
  const limit = straight * maxDetour + slackKm;
  const found = shortestPath(graph, na.id, nb.id, limit);
  if (!found || found.km > limit) return null;
  return [a, ...found.nodes.map((id) => graph.coords[id]), b];
}

/**
 * A line through `stops` in order, each gap routed on the first graph that
 * can route it (OSM first, a feed's shapes second), else left to `fallback`
 * (which returns the gap's points, or null for a straight chord). Returns the
 * path and where each gap came from.
 */
export function routeThroughStops(stops, graphs, fallback = () => null, memo = new Map()) {
  const path = [stops[0]];
  const sources = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    let seg = null;
    let source = "chord";
    const key = `${a}|${b}`;
    const back = `${b}|${a}`;
    if (memo.has(key)) [seg, source] = memo.get(key);
    else if (memo.has(back)) {
      const [s0, src] = memo.get(back);
      [seg, source] = [s0 ? [...s0].reverse() : null, src];
    } else {
      for (const [name, graph] of graphs) {
        seg = routeBetween(graph, a, b);
        if (seg) {
          source = name;
          break;
        }
      }
      if (seg) memo.set(key, [seg, source]);
    }
    if (!seg) {
      const fb = fallback(a, b);
      if (fb && fb.length >= 2) {
        seg = fb;
        source = "siblings";
      }
    }
    sources.push(source);
    path.push(...(seg ? seg.slice(1) : [b]));
  }
  return { path, sources };
}

/**
 * Douglas–Peucker on [lat, lon], keeping every index in `keep` (a junction a
 * branch starts from, which must survive or the branch comes loose).
 */
export function simplifyPath(points, toleranceM = 15, keep = new Set()) {
  if (points.length <= 2) return points.slice();
  const tol = toleranceM / 1000;
  const cosLat = Math.cos(rad(points[0][0]));
  const xy = points.map(([lat, lon]) => [lon * 111.32 * cosLat, lat * 110.57]);
  const marked = new Uint8Array(points.length);
  marked[0] = marked[points.length - 1] = 1;
  for (const i of keep) if (i >= 0 && i < points.length) marked[i] = 1;
  const stack = [];
  // Split at every kept index first, then simplify each span on its own.
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (marked[i]) {
      stack.push([start, i]);
      start = i;
    }
  }
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > tol) {
      marked[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => marked[i]);
}

/**
 * Overpass railway ways (`out geom`, which carries each way's node ids beside
 * its geometry) → simplified polylines, junction nodes kept.
 */
export function trackFromOverpass(answer, { toleranceM = 15 } = {}) {
  const ways = (answer?.elements ?? []).filter(
    (e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 2,
  );
  const uses = new Map();
  for (const w of ways) for (const id of w.nodes ?? []) uses.set(id, (uses.get(id) ?? 0) + 1);
  return ways.map((w) => {
    const pts = w.geometry.map((g) => [Math.round(g.lat * 1e5) / 1e5, Math.round(g.lon * 1e5) / 1e5]);
    const keep = new Set();
    (w.nodes ?? []).forEach((id, i) => {
      if ((uses.get(id) ?? 0) > 1) keep.add(i);
    });
    return simplifyPath(pts, toleranceM, keep);
  });
}
