// scripts/lib/enrich-view-map.mjs
// Registry-driven view-map enrichment post-step (runs after all adapters in
// scripts/scrape-data.mjs). For every registry entry with an `enrich` config,
// matched Back-on-Track rows are updated in place from that source's official
// data: polylines, official stop lists (via_*), endpoint times, and the
// `official_sources` stamp the nightly classifier uses to auto-approve routes
// corroborated by a trusted source. Pure module — callers inject readers.
//
// Strategies (entry.enrich.strategy):
//   • trainsByNumber — match rows by trip_short_name_0/1 against a per-source
//     trains file (nightjet, europeansleeper). Options: setPolyline
//     (+ polylineMode "legacy"|"perDirection"), updateVia, setTimes,
//     updateEndpoints, updateServiceDays, stamp, agencyIds scope,
//     addSyntheticLeftovers.
//   • gtfsBundle — match rows against a committed GTFS bundle keyed by train
//     number (pkp-gtfs), endpoint-validated via gtfsEntryForRoute so reused
//     train numbers can't stamp wrong-corridor rows. Leo Express also matches
//     by corridor when BoT commercial numbers differ from mkuran keys.
//     Options: updateVia, stamp, agencyIds.

import {
  gtfsEntryForRoute,
  extractKeysFromTripLabel,
} from "../../src/lib/pkpTrainKeyExtract.js";
import { buildVia } from "../../src/lib/pkpGtfsMerge.js";
import { inAgencyScope } from "../../src/pages/api/lib/primitives.mjs";

// "2026-06-11T18:13:00.000Z" → "18:13" (BoT rows carry plain HH:MM strings).
function toHHMM(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

// Recomputed from a fresh BoT view map every night, so stamps never
// accumulate across runs — they always reflect tonight's corroboration.
function stampOfficialSource(route, sourceId) {
  const existing = Array.isArray(route.official_sources)
    ? route.official_sources
    : [];
  route.official_sources = [...new Set([...existing, sourceId])].sort();
}


function trainsByNumber({ entry, viewMap, trains, log }) {
  const opts = entry.enrich;
  let touched = 0;

  Object.values(viewMap).forEach((route) => {
    if (!inAgencyScope(route, opts.agencyIds)) return;

    // Legacy polyline merge (NightJet): one nj_polyline field, first matching
    // direction wins — byte-compatible with the original finalizeViewMap.
    if (opts.setPolyline && (opts.polylineMode ?? "legacy") === "legacy") {
      const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
      for (const name of names) {
        const match = trains[name.toString().trim()];
        if (match?.polyline) {
          route.nj_polyline = match.polyline;
          break;
        }
      }
    }

    let matchedAny = false;
    for (const d of [0, 1]) {
      const name = route[`trip_short_name_${d}`];
      const match = name ? trains[name.toString().trim()] : null;
      if (!match) continue;
      matchedAny = true;

      if (opts.setPolyline && opts.polylineMode === "perDirection" && match.polyline) {
        route[`nj_polyline_${d}`] = match.polyline;
      }
      if (opts.updateVia && match.stations?.length >= 2) {
        const via = match.stations
          .slice(1, -1)
          .map((s) => s?.name)
          .filter(Boolean)
          .join(" - ");
        if (via) route[`via_${d}`] = via;
      }
      if (opts.setTimes && match.stations?.length >= 2) {
        const dep = toHHMM(match.stations[0]?.departure);
        const arr = toHHMM(match.stations[match.stations.length - 1]?.arrival);
        if (dep) route[`origin_departure_time_${d}`] = dep;
        if (arr) route[`destination_arrival_time_${d}`] = arr;
      }
      // Where the train actually starts and ends. Back-on-Track's endpoints go
      // stale when an operator diverts: it still calls ES 474/475 "Berlin Hbf"
      // while the feed runs them from Berlin-Spandau and into Berlin
      // Gesundbrunnen — so the row's own polyline reached a different place
      // than its endpoint marker. Off by default; a source opts in only when
      // its feed is the operator's own timetable.
      if (opts.updateEndpoints && match.stations?.length >= 2) {
        const origin = match.stations[0]?.name;
        const dest = match.stations[match.stations.length - 1]?.name;
        if (origin) route[`origin_trip_${d}`] = origin;
        if (dest) route[`destination_trip_${d}`] = dest;
      }
      // Service days, with the period they apply to. BoT's undated "2026: Mon,
      // Wed, Fri" reads as the whole year even when the timetable changes in
      // December; the feed dates its own window.
      if (opts.updateServiceDays && match.frequency) {
        route[`service_id_${d}`] = match.frequency;
      }
    }

    if (matchedAny && opts.stamp) {
      stampOfficialSource(route, entry.id);
      touched++;
    }
  });

  if (opts.stamp) log(`${entry.id}: stamped ${touched} view-map row(s)`);
}

async function gtfsBundle({ entry, viewMap, bundle, stopCoords, resolveGeometry, log }) {
  const opts = entry.enrich;
  const byTrainKey = bundle?.byTrainKey;
  if (!byTrainKey) {
    log(`${entry.id}: GTFS bundle missing — enrichment skipped`);
    return;
  }
  let touched = 0;

  for (const [routeKey, route] of Object.entries(viewMap)) {
    if (!inAgencyScope(route, opts.agencyIds)) continue;

    // Endpoint-validated per direction: a reused train number whose shape
    // serves a different corridor resolves to null and the row stays as-is.
    // Leo Express also matches by corridor when BoT commercial numbers
    // (LE 232/235) differ from mkuran operational numbers (1248/1249).
    const agency = (route?.agency_id ?? "").toString().trim();
    const e0 = gtfsEntryForRoute(
      route.trip_short_name_0,
      byTrainKey,
      route.origin_trip_0,
      route.destination_trip_0,
      agency,
    );
    const e1 = gtfsEntryForRoute(
      route.trip_short_name_1,
      byTrainKey,
      route.origin_trip_1,
      route.destination_trip_1,
      agency,
    );

    if (e0 || e1) {
      if (opts.updateVia) {
        const via0 = e0 ? buildVia(e0.stops, route.origin_trip_0, route.destination_trip_0) : null;
        const via1 = e1 ? buildVia(e1.stops, route.origin_trip_1, route.destination_trip_1) : null;
        if (via0) route.via_0 = via0;
        if (via1) route.via_1 = via1;
      }
      if (opts.stamp) {
        stampOfficialSource(route, entry.id);
        touched++;
      }
    }

    // Geometry fallback for rows the bundle can't corroborate (e.g. the
    // cross-border Carpathia, whose Czech leg isn't in the Polish feed):
    // OSM-backed, endpoint-validated, hash-gated on the BoT stop list.
    // Geometry only — never a stamp; OSM is not official corroboration.
    if (opts.geometryFallback && resolveGeometry) {
      for (const [d, matched] of [[0, e0], [1, e1]]) {
        if (matched || route[`nj_polyline_${d}`] || route.nj_polyline) continue;
        const label = route[`trip_short_name_${d}`];
        if (!label) continue;
        const names = [
          route[`origin_trip_${d}`],
          ...(route[`via_${d}`] ?? "").split(" - "),
          route[`destination_trip_${d}`],
        ].filter(Boolean);
        const stops = names.map((name) => ({ name, ...(stopCoords?.(name) ?? {}) }));
        const keys = extractKeysFromTripLabel(label);
        const pinned = [
          ...new Set(keys.flatMap((k) => opts.geometryFallback.pinnedRelations?.[k] ?? [])),
        ];
        const resolved = await resolveGeometry({
          key: `${entry.id}:${routeKey}:${d}`,
          stops,
          pinnedRelationIds: pinned,
          refCandidates: [...new Set([label, ...keys])],
          operatorRegex: opts.geometryFallback.operatorRegex ?? null,
          allowChain: false,
        });
        if (resolved?.polyline) route[`nj_polyline_${d}`] = resolved.polyline;
      }
    }
  }

  if (opts.stamp) log(`${entry.id}: stamped ${touched} view-map row(s)`);
}

const STRATEGIES = { trainsByNumber, gtfsBundle };

/**
 * Apply every enabled registry entry's enrichment to the view map, in registry
 * order. Enrichment is best-effort per source: a failure is logged and the
 * remaining sources still run (the scrape must never die here).
 *
 * @param {object} args
 * @param {Array}  args.registry
 * @param {object} args.viewMap    Mutated in place (rows updated/stamped)
 * @param {(entry: object) => object|undefined} args.getTrains  Per-source
 *   trains dict (runner: ctx.writtenTrains with disk fallback; tests: fixture)
 * @param {(relPath: string) => object|null} args.readJson  For gtfsBundle
 *   statusFile reads
 * @param {(name: string) => {lat:number, lon:number}|null} [args.stopCoords]
 *   Station-name → coords (BoT stops), for the geometry-fallback stop lists
 * @param {(args: object) => Promise<{polyline: string|null}>} [args.resolveGeometry]
 *   OSM-backed geometry resolver (scripts/lib/route-geometry.mjs, bound to the
 *   shared cache by the runner); null disables the fallback
 * @param {(msg: string) => void} [args.log]
 */
export async function enrichViewMap({
  registry,
  viewMap,
  getTrains,
  readJson,
  stopCoords = null,
  resolveGeometry = null,
  log = () => {},
}) {
  for (const entry of registry ?? []) {
    const strategy = STRATEGIES[entry?.enrich?.strategy];
    if (!entry?.enabled || !strategy) continue;
    try {
      if (entry.enrich.strategy === "trainsByNumber") {
        strategy({ entry, viewMap, trains: getTrains?.(entry) ?? {}, log });
      } else {
        const bundle = entry.params?.statusFile ? readJson?.(entry.params.statusFile) : null;
        await strategy({ entry, viewMap, bundle, stopCoords, resolveGeometry, log });
      }
    } catch (err) {
      log(`${entry.id}: enrichment failed — ${err.message}`);
    }
  }
}

/**
 * Synthetic view-map rows for official trains Back-on-Track doesn't know about
 * (extracted from the original NightJet-only finalizeViewMap, generalized to
 * any trainsByNumber source via its registry synthetic config). The build step
 * recreates these from the trains file anyway; the raw-file copies keep the
 * committed view map self-contained for the GitHub-fallback serving path.
 */
export function appendSyntheticLeftovers({ entry, viewMap, trains, log = () => {} }) {
  const synthetic = entry?.synthetic;
  if (!synthetic?.idPrefix) return;

  // Scoped like excludeBotMatched in build-initial-data: a bare number is only
  // unique within an operator, so an unscoped match lets e.g. BoT's CFM/CFR 401
  // swallow European Sleeper's ES 401 (and break its reverse pairing).
  const matched = new Set();
  Object.values(viewMap)
    .filter((route) => inAgencyScope(route, synthetic.botMatchAgencies))
    .forEach((route) => {
      [route.trip_short_name_0, route.trip_short_name_1]
        .filter(Boolean)
        .forEach((n) => matched.add(n.toString().trim()));
    });

  const agencyOf =
    synthetic.agency?.from === "data"
      ? (data) => data.agency_id || synthetic.agency.fallback
      : () => synthetic.agency?.value;

  const unmatched = Object.entries(trains).filter(
    ([lineName, data]) =>
      !matched.has(lineName) && data.polyline && data.stations?.length >= 2,
  );

  const paired = new Set();
  unmatched.forEach(([lineName, data]) => {
    if (paired.has(lineName)) return;

    const origin = data.stations[0].name;
    const dest = data.stations[data.stations.length - 1].name;

    const reversePair = unmatched.find(
      ([k, v]) =>
        k !== lineName &&
        !paired.has(k) &&
        v.stations?.[0]?.name === dest &&
        v.stations?.[v.stations.length - 1]?.name === origin,
    );

    const safeId = lineName.replace(/\s+/g, "_");
    const entryRow = {
      route_id: `${synthetic.idPrefix}${safeId}`,
      agency_id: agencyOf(data),
      trip_short_name_0: lineName,
      origin_trip_0: origin,
      destination_trip_0: dest,
      via_0: data.stations.slice(1, -1).map((s) => s.name).join(" - "),
      route_long_name: `${origin} – ${dest}`,
      nj_polyline: data.polyline,
      is_active: "Y",
    };

    if (reversePair) {
      const [revName, revData] = reversePair;
      entryRow.trip_short_name_1 = revName;
      entryRow.origin_trip_1 = revData.stations[0].name;
      entryRow.destination_trip_1 = revData.stations[revData.stations.length - 1].name;
      entryRow.via_1 = revData.stations.slice(1, -1).map((s) => s.name).join(" - ");
      paired.add(revName);
    }

    paired.add(lineName);
    viewMap[entryRow.route_id] = entryRow;
    log(`synthetic route: ${entryRow.route_id} (${origin} – ${dest})`);
  });
}
