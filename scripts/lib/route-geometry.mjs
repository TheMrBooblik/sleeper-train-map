// scripts/lib/route-geometry.mjs
// Polyline generation for official sources that publish stop lists but no
// geometry (European Sleeper first; any future polyline-less source).
//
// The user-facing rule: geometry is regenerated ONLY when the official stop
// list changed. A committed cache (public/data/scraped/route-geometry.json)
// keyed by `${sourceId}:${train}` stores the encoded polyline together with
// the hash of the stop list that produced it — a cache hit with an equal hash
// returns instantly with zero network. Failed lookups ("none") retry after 7
// days so Overpass isn't hammered nightly for routes OSM doesn't know.
//
// Strategy chain per route:
//   1. pinned OSM relations (registry params) read from the daily scraped
//      osm-{id}.json files — no network;
//   2. Overpass discovery: route=train relations matching the train ref (and
//      optionally operator), validated like the pinned ones (endpoints + via);
//   3. straight-line chain through the official stop coordinates (mirrors the
//      NightJet adapter's fallback so synthetic rows always render).
// Every OSM candidate must end within ~30 km of the official first/last stop
// (either orientation; geometry is flipped to run origin → destination) AND
// pass within ~12 km of every intermediate stop that has coordinates. Endpoint
// matching alone accepted OSM 8737075 (Praha–Warszawa via Oświęcim) for the
// Chopin sleeper, whose real via is Katowice ~27 km off that track.

import polyline from "@mapbox/polyline";
import { hashString } from "./classify.mjs";
import { OVERPASS_ENDPOINTS } from "./scrape-helpers.mjs";
import { maxStationDeviationKm } from "./sibling-path.mjs";
import {
  extractCoordsFromRelation,
  deduplicateConsecutive,
} from "../../src/pages/api/lib/osm-geo.mjs";

const NONE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const ENDPOINT_TOLERANCE_KM = 30;
// Station building vs track is typically <1 km. 12 km still rejects a
// different city (Katowice vs the Oświęcim corridor) without failing on
// a slightly offset OSM vertex.
const VIA_TOLERANCE_KM = 12;

export function stopListHash(stopNames) {
  return hashString((stopNames ?? []).map((n) => (n ?? "").trim()).join("~"));
}

export function emptyGeometryCache() {
  return { entries: {} };
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Accepts coords only when both ends sit near the official endpoints, in
// either orientation, AND every intermediate stop with coordinates lies on
// the path. Returns them oriented origin → destination, or null.
// `midPoints` is [[lat, lon], ...] — origin/dest themselves are not listed
// here; they already passed the looser 30 km endpoint check.
function validateAndOrient(coords, origin, dest, midPoints = []) {
  if (!Array.isArray(coords) || coords.length < 2 || !origin || !dest) return null;
  const start = coords[0];
  const end = coords[coords.length - 1];
  const o = [origin.lat, origin.lon];
  const d = [dest.lat, dest.lon];
  let oriented = null;
  if (
    haversineKm(start, o) <= ENDPOINT_TOLERANCE_KM &&
    haversineKm(end, d) <= ENDPOINT_TOLERANCE_KM
  ) {
    oriented = coords;
  } else if (
    haversineKm(start, d) <= ENDPOINT_TOLERANCE_KM &&
    haversineKm(end, o) <= ENDPOINT_TOLERANCE_KM
  ) {
    oriented = [...coords].reverse();
  }
  if (!oriented) return null;
  if (
    midPoints.length > 0 &&
    maxStationDeviationKm(midPoints, oriented) > VIA_TOLERANCE_KM
  ) {
    return null;
  }
  return oriented;
}

async function queryOverpass(query, fetchImpl) {
  let response = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "train-map/1.0" },
        body: query,
      });
      if (response.ok) break;
    } catch {
      // try next endpoint
    }
  }
  if (!response?.ok) throw new Error("All Overpass endpoints failed");
  return response.json();
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolve (and cache) the geometry for one train's official stop list.
 *
 * @param {object} args
 * @param {string} args.key                Cache key, `${sourceId}:${train}`
 * @param {{name: string, lat?: number, lon?: number}[]} args.stops  Ordered
 *   official stop list (coords where known)
 * @param {string[]} [args.pinnedRelationIds]  OSM relations from the registry
 * @param {string[]} [args.refCandidates]  Train refs for Overpass discovery
 * @param {string|null} [args.operatorRegex]  Extra Overpass operator match
 * @param {{entries: object}} args.cache   Mutated in place
 * @param {(id: string) => number[][]|null} [args.readScrapedRelation]  Reader
 *   over the daily osm-{id}.json files (no network)
 * @param {typeof fetch|null} [args.fetchImpl]  null disables Overpass entirely
 * @param {Date} [args.now]
 * @returns {Promise<{polyline: string|null, method: string, stopsHash: string, relationId?: string}>}
 */
export async function resolveRouteGeometry({
  key,
  stops,
  pinnedRelationIds = [],
  refCandidates = [],
  operatorRegex = null,
  cache,
  readScrapedRelation = null,
  fetchImpl = globalThis.fetch,
  // false = OSM-or-nothing: callers whose renderer already straight-lines
  // missing geometry (BoT rows) gain nothing from a chained polyline, and a
  // cached chain would block the weekly OSM retry.
  allowChain = true,
  now = new Date(),
  log = () => {},
}) {
  const stopsHash = stopListHash((stops ?? []).map((s) => s?.name));
  const cached = cache?.entries?.[key];
  if (cached && cached.stopsHash === stopsHash) {
    const freshFailure =
      cached.method === "none" &&
      now.getTime() - Date.parse(cached.updatedAt ?? 0) < NONE_RETRY_MS;
    if (cached.method !== "none" || freshFailure) return cached;
  }

  const coordStops = (stops ?? []).filter(
    (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon),
  );
  const origin = coordStops[0] ?? null;
  const dest = coordStops[coordStops.length - 1] ?? null;
  // Intermediate stops only — origin/dest already use the 30 km endpoint gate.
  const midPoints = coordStops.slice(1, -1).map((s) => [s.lat, s.lon]);
  const finish = (entry) => {
    const full = { ...entry, stopsHash, updatedAt: now.toISOString() };
    if (cache) cache.entries[key] = full;
    return full;
  };

  if (origin && dest && origin !== dest) {
    // 1. Pinned relations (already scraped daily — zero network).
    for (const relationId of pinnedRelationIds) {
      const coords = readScrapedRelation?.(String(relationId));
      const oriented = validateAndOrient(coords, origin, dest, midPoints);
      if (oriented) {
        log(`${key}: geometry from pinned OSM relation ${relationId}`);
        return finish({
          polyline: polyline.encode(oriented),
          method: "osm-pinned",
          relationId: String(relationId),
        });
      }
    }

    // 2. Overpass discovery by train ref / operator. Same endpoint + via
    //    checks as the pinned path, so a wrong-corridor relation (e.g. EN 443
    //    via Oświęcim) cannot sneak back in after we drop its pin.
    if (fetchImpl && (refCandidates.length || operatorRegex)) {
      try {
        const refAlt = refCandidates.map(escapeRegex).join("|");
        const clauses = [];
        if (refAlt) {
          clauses.push(`relation["route"="train"]["ref"~"(^|;|/| )(${refAlt})($|;|/| )"];`);
        }
        if (operatorRegex) {
          clauses.push(`relation["route"="train"]["operator"~"${operatorRegex}",i];`);
        }
        const data = await queryOverpass(
          `[out:json][timeout:30];\n(\n  ${clauses.join("\n  ")}\n);\nout geom;`,
          fetchImpl,
        );
        let best = null;
        for (const el of data?.elements ?? []) {
          if (el.type !== "relation") continue;
          const coords = deduplicateConsecutive(extractCoordsFromRelation(el));
          const oriented = validateAndOrient(coords, origin, dest, midPoints);
          if (oriented && (!best || oriented.length > best.coords.length)) {
            best = { coords: oriented, relationId: String(el.id) };
          }
        }
        if (best) {
          log(`${key}: geometry from discovered OSM relation ${best.relationId}`);
          return finish({
            polyline: polyline.encode(best.coords),
            method: "overpass",
            relationId: best.relationId,
          });
        }
      } catch (err) {
        log(`${key}: Overpass discovery failed — ${err.message}`);
      }
    }
  }

  // 3. Straight-line chain through the official stop coordinates.
  if (allowChain && coordStops.length >= 2) {
    return finish({
      polyline: polyline.encode(coordStops.map((s) => [s.lat, s.lon])),
      method: "stops-chain",
    });
  }

  return finish({ polyline: null, method: "none" });
}
