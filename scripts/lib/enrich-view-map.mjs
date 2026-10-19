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
import { splitViaString } from "../../src/lib/viaSplit.mjs";
import { sameTrainAsRow } from "../../src/lib/sameTrain.mjs";

// "2026-06-11T18:13:00.000Z" → "18:13" (BoT rows carry plain HH:MM strings).
/**
 * "HH:MM" out of the shapes the sources emit, or null.
 *
 * Three formats are in the tree and only two were handled. NightJet writes
 * "2026-09-13T16:01:00.000Z" and European Sleeper "2026-09-13T15:55:00" (plus
 * a `T`-prefixed wrap for past-midnight times), which the `T` anchor catches.
 * But `gtfs-sleeper` — SNCF, Entur, Amtrak, VIA — writes a bare "22:47", and
 * against that the `T` anchor returned null: `setTimes` would have been a
 * SILENT no-op for every one of them, the shape of fault that looks correct
 * right up until somebody switches the option on.
 *
 * The bare form is anchored to the whole string so a date can never be read as
 * a time, and the `T` match still wins where both could apply. GTFS's past-
 * midnight hours (25:10) never reach here — buildSleeperTrains wraps them
 * before emitting, confirmed across all 1 838 times in the committed files —
 * but they are wrapped here too rather than trusted to stay that way.
 */
function toHHMM(value) {
  if (!value || typeof value !== "string") return null;
  const iso = value.match(/T(\d{1,2}):(\d{2})/);
  const bare = iso ? null : value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  const m = iso ?? bare;
  if (!m) return null;
  const hours = Number(m[1]);
  if (!Number.isFinite(hours)) return null;
  return `${String(hours % 24).padStart(2, "0")}:${m[2]}`;
}

// Recomputed from a fresh BoT view map every night, so stamps never
// accumulate across runs — they always reflect tonight's corroboration.
function stampOfficialSource(route, sourceId) {
  const existing = Array.isArray(route.official_sources)
    ? route.official_sources
    : [];
  route.official_sources = [...new Set([...existing, sourceId])].sort();
}


function trainsByNumber({ entry, viewMap, trains, stopCoords, log }) {
  const opts = entry.enrich;
  const isKnownStation = stopCoords ? (n) => !!stopCoords(n) : null;
  let touched = 0;
  // `requireSameTrain`: a number names this row's train only when the train
  // also ends in one of the row's end cities (src/lib/sameTrain.mjs). Without
  // it nightjet.com's Budapest–Stuttgart EN 442 drew its line onto
  // Back-on-Track's Humenné–Praha EN 442.
  const trainFor = (route, name) => {
    const match = name ? trains[name.toString().trim()] : null;
    if (!match) return null;
    return !opts.requireSameTrain || sameTrainAsRow(route, match) ? match : null;
  };

  Object.values(viewMap).forEach((route) => {
    if (!inAgencyScope(route, opts.agencyIds)) return;

    // Legacy polyline merge (NightJet): one nj_polyline field, first matching
    // direction wins — byte-compatible with the original finalizeViewMap.
    if (opts.setPolyline && (opts.polylineMode ?? "legacy") === "legacy") {
      const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
      for (const name of names) {
        const match = trainFor(route, name);
        if (match?.polyline) {
          route.nj_polyline = match.polyline;
          break;
        }
      }
    }

    let matchedAny = false;
    let tookAnyFeedTrip = false;
    for (const d of [0, 1]) {
      const match = trainFor(route, route[`trip_short_name_${d}`]);
      if (!match) continue;
      matchedAny = true;

      if (opts.setPolyline && opts.polylineMode === "perDirection" && match.polyline) {
        route[`nj_polyline_${d}`] = match.polyline;
      }
      // Whether this row takes the feed's trip at all. It gates the stop
      // list, the times AND the stamp together, because a row describes ONE
      // train: taking a trip's stops while keeping someone else's times is not
      // a compromise, it is a row that contradicts itself. It did — on the
      // published payload 16 of 18 SNCF directions carried the feed's exact
      // stop list beside Back-on-Track's endpoint times, disagreeing on 16 of
      // them and by an hour or more on 6, worst 183 minutes.
      let takesFeedTrip = true;
      if (opts.updateVia && match.stations?.length >= 2) {
        const stops = match.stations
          .slice(1, -1)
          .map((s) => s?.name)
          .filter(Boolean);
        // Official is better than Back-on-Track when it is more complete, and
        // that is not a given per row: SNCF's feed carries the Aurillac
        // portion as a 3-stop stub, whose one via station would have replaced
        // Back-on-Track's Laroquebrou / Bretenoux Biars / St-Denis-lès-Martel.
        // Opt-in, because a source whose stop list is authoritative even when
        // shorter (a diverted train calling at fewer stations) wants the
        // replacement.
        // Count the incumbent by STATION, not by separator. 437 stops carry
        // " - " inside their own name, so a plain split counts "Rocamadour -
        // Padirac" as two — the existing list looks richer than it is and a
        // genuinely better official list is refused. Exactly backwards for a
        // guard whose whole job is "only replace with something fuller".
        const ok =
          !opts.viaOnlyIfRicher ||
          stops.length >=
            splitViaString(route[`via_${d}`], isKnownStation).length;
        takesFeedTrip = Boolean(stops.length && ok);
        if (takesFeedTrip) route[`via_${d}`] = stops.join(" - ");
      }
      if (takesFeedTrip) tookAnyFeedTrip = true;
      if (takesFeedTrip && opts.setTimes && match.stations?.length >= 2) {
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
      if (takesFeedTrip && opts.updateEndpoints && match.stations?.length >= 2) {
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

    // Stamp only where official data actually landed. A row whose feed trip
    // was refused kept Back-on-Track's everything, and claiming corroboration
    // for it would tell the integrations dashboard a first-party source feeds
    // a route it does not.
    if (tookAnyFeedTrip && opts.stamp) {
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
          // A torn name resolves to no coordinate, so the chain silently
          // loses the vertex and the drawn line skips the stop.
          ...splitViaString(route[`via_${d}`], (n) => !!stopCoords?.(n)),
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
        // stopCoords too: trainsByNumber needs it to count the incumbent via
        // list by STATION rather than by separator. Without it the count falls
        // back to the naive split, "Mont-Dauphin - Guillestre" reads as two,
        // and viaOnlyIfRicher refuses an official list that is exactly as
        // complete — 13 of 18 SNCF directions, silently.
        strategy({ entry, viewMap, trains: getTrains?.(entry) ?? {}, stopCoords, log });
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

  // Withdraw before appending. This function used only to add, and the view map
  // it writes to is committed — so a row it created outlived its train forever,
  // and removing an allowlist entry did nothing visible at all. Four entries
  // selected by Romania's "IR-N" night-train prefix turned out to belong to
  // Astra Trans Carpatic rather than CFR; taking them out of the allowlist left
  // their rows sitting in the file, one of them a second line over the
  // Back-on-Track row for the same train, and only a hand edit removed them.
  //
  // Safe against an outage because the sticky merge runs first: a source that
  // fails to fetch keeps yesterday's trains for seven days, so a train missing
  // from `trains` here is one the source has genuinely stopped carrying.
  const withdrawn = [];
  for (const key of Object.keys(viewMap)) {
    if (!key.startsWith(synthetic.idPrefix)) continue;
    const row = viewMap[key];
    const names = [row?.trip_short_name_0, row?.trip_short_name_1]
      .filter(Boolean)
      .map((n) => n.toString().trim());
    if (names.length && names.every((n) => !trains[n])) {
      delete viewMap[key];
      withdrawn.push(key);
    }
  }
  if (withdrawn.length) {
    log(`${entry.id}: withdrew ${withdrawn.length} synthetic row(s) whose train is gone: ${withdrawn.join(", ")}`);
  }

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
