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
//     trains file (nightjet today, europeansleeper next). Options: setPolyline
//     (+ polylineMode "legacy"|"perDirection"), updateVia, setTimes, stamp,
//     agencyIds scope, addSyntheticLeftovers.
//   • gtfsBundle — match rows against a committed GTFS bundle keyed by train
//     number (pkp-gtfs), endpoint-validated via pkpEntryForRoute so reused
//     train numbers can't stamp wrong-corridor rows. Options: updateVia,
//     stamp, agencyIds.

import {
  pkpEntryForRoute,
  extractKeysFromTripLabel,
} from "../../src/lib/pkpTrainKeyExtract.js";
import { buildVia } from "../../src/lib/pkpGtfsMerge.js";
import { stopsRunBetween, sliceToJourney } from "./station-city.mjs";

// BoT rows carry plain HH:MM strings. Sources give either an ISO timestamp
// (NightJet: "2026-06-11T18:13:00.000Z") or an already-plain clock reading
// (ČD: "22:16", and "9:41" without the leading zero).
function toHHMM(value) {
  if (!value || typeof value !== "string") return null;
  const iso = value.match(/T(\d{2}:\d{2})/);
  if (iso) return iso[1];
  const plain = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!plain) return null;
  const h = Number(plain[1]);
  if (h > 23 || Number(plain[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${plain[2]}`;
}

// Recomputed from a fresh BoT view map every night, so stamps never
// accumulate across runs — they always reflect tonight's corroboration.
function stampOfficialSource(route, sourceId) {
  const existing = Array.isArray(route.official_sources)
    ? route.official_sources
    : [];
  route.official_sources = [...new Set([...existing, sourceId])].sort();
}

function inAgencyScope(route, agencyIds) {
  if (!Array.isArray(agencyIds) || agencyIds.length === 0) return true;
  return agencyIds.includes((route?.agency_id ?? "").toString().trim());
}

// Sources name their stop list differently: NightJet writes `stations`, the ČD
// scrape writes `stops`. Same shape otherwise — {name, arrival, departure}.
function stopListOf(match) {
  const list = match?.stations ?? match?.stops;
  return Array.isArray(list) ? list : [];
}

// Sources key their trains differently too: NightJet by the full label it was
// matched on ("NJ 403"), ČD by the bare number it fetched ("442"). Try the
// label first so an exact key always wins, then the number inside it.
function lookupTrain(trains, label) {
  const key = (label ?? "").toString().trim();
  if (!key) return null;
  if (trains[key]) return trains[key];
  const number = key.match(/\d{3,6}/)?.[0];
  return number ? (trains[number] ?? null) : null;
}

function trainsByNumber({ entry, viewMap, trains, log }) {
  const opts = entry.enrich;
  let touched = 0;

  Object.values(viewMap).forEach((route) => {
    if (!inAgencyScope(route, opts.agencyIds)) return;
    // Fallback sources fill only what better ones left empty. `official_sources`
    // is the claim marker: it is recomputed from a fresh view map every night,
    // and the registry order puts the sources with real geometry first, so a
    // row already stamped by PKP or NightJet keeps their data.
    if (opts.onlyUnclaimed && route.official_sources?.length) return;

    // Legacy polyline merge (NightJet): one nj_polyline field, first matching
    // direction wins — byte-compatible with the original finalizeViewMap.
    if (opts.setPolyline && (opts.polylineMode ?? "legacy") === "legacy") {
      const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
      for (const name of names) {
        const match = lookupTrain(trains, name);
        if (match?.polyline) {
          route.nj_polyline = match.polyline;
          break;
        }
      }
    }

    let matchedAny = false;
    for (const d of [0, 1]) {
      const name = route[`trip_short_name_${d}`];
      const match = lookupTrain(trains, name);
      if (!match) continue;

      let stopList = stopListOf(match);
      const origin = route[`origin_trip_${d}`];
      const destination = route[`destination_trip_${d}`];
      // Defence in depth for number-ambiguous sources: the adapter already
      // discards a response that doesn't serve the requesting row, but the
      // committed file may predate that check, so never write a stop list that
      // runs somewhere else.
      if (opts.validateEndpoints) {
        if (!stopsRunBetween(stopList, origin, destination)) continue;
        // Keep only the row's own journey, so a list that runs past the
        // endpoints can't hand the row someone else's arrival time.
        const journey =
          sliceToJourney(stopList, origin, destination) ??
          sliceToJourney([...stopList].reverse(), origin, destination);
        if (!journey) continue;
        stopList = journey;
      }
      matchedAny = true;
      if (opts.setPolyline && opts.polylineMode === "perDirection" && match.polyline) {
        route[`nj_polyline_${d}`] = match.polyline;
      }
      if (opts.updateVia && stopList.length >= 2) {
        const via = stopList
          .slice(1, -1)
          .map((s) => s?.name)
          .filter(Boolean)
          .join(" - ");
        if (via) route[`via_${d}`] = via;
      }
      if (opts.setTimes && stopList.length >= 2) {
        const dep = toHHMM(stopList[0]?.departure);
        const arr = toHHMM(stopList[stopList.length - 1]?.arrival);
        if (dep) route[`origin_departure_time_${d}`] = dep;
        if (arr) route[`destination_arrival_time_${d}`] = arr;
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
    const e0 = pkpEntryForRoute(
      route.trip_short_name_0,
      byTrainKey,
      route.origin_trip_0,
      route.destination_trip_0,
    );
    const e1 = pkpEntryForRoute(
      route.trip_short_name_1,
      byTrainKey,
      route.origin_trip_1,
      route.destination_trip_1,
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

  const matched = new Set();
  Object.values(viewMap).forEach((route) => {
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
