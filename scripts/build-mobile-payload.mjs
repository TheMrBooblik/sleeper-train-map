#!/usr/bin/env node
/**
 * Build the render-ready payload the mobile app draws.
 *
 * The map's logic — route styling, colour assignment, return-direction corridor
 * de-duplication, OSM/static geometry substitution, city clustering — is ~2000
 * lines of pure JS in this repo, and porting it to Dart would create a second
 * implementation that drifts the first time the pipeline changes. So the app
 * does not get the logic; it gets the *result*. This script runs the repo's own
 * modules once, in the nightly Action, and writes a payload the client only has
 * to decode and paint.
 *
 * What deliberately does NOT get baked: anything that depends on today's date.
 * `isRouteOutsideServiceIdSeason` and `getFutureRouteStartDate` both read the
 * clock, so a payload that froze their verdicts would tell a phone in November
 * what was true in August — and the app ships a seed copy that can be months
 * old. Instead the payload carries their *inputs* (`seasonRanges`,
 * `futureStarts`) and the app re-evaluates them against its own clock.
 *
 * Run: npm run build-mobile-payload
 * Output: public/data/published/mobile-v1.json
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { stripDisabledRoutes } from "../src/pages/api/lib/build-initial-data.mjs";
import { enrichInitialData } from "../src/lib/enrich-payload.mjs";
import { buildAllRoutesPaths } from "../src/components/Map/utils/buildAllRoutesPaths.js";
import { groupCityMarkers } from "../src/components/Map/utils/groupCityMarkers.js";
import { normalizeStationNameForDisplay } from "../src/components/Map/utils/stationNameUtils.js";
import { normalizeStationNameForLookup } from "../src/hooks/requests/useCities.js";
import {
  parseBoTServiceIdDateRange,
  hasUnknownStart,
  shouldDrawFutureRouteAsActive,
  isRouteOutsideServiceIdSeason,
} from "../src/components/Map/utils/routeStyleUtils.js";
import { relationCoordsFromOverpass } from "../src/pages/api/lib/osm-geo.mjs";
import { buildBookingUrl, getDealsLink } from "../src/lib/operatorBooking.js";
import { stationsToSkip } from "../src/data/stationsToSkip.js";
import { alwaysShowStations } from "../src/data/alwaysShowStations.js";
import {
  encodeStroke,
  parseDashArray,
  DEFAULT_TOLERANCE_DEG,
} from "./lib/mobile-geometry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "public/data/published/mobile-v1.json");

/** Schema version. A breaking change goes to mobile-v2.json; published apps keep reading v1. */
const SCHEMA_VERSION = 1;

/** Fail rather than ship something that will not fit a phone's budget. */
const MAX_RAW_BYTES = 3 * 1024 * 1024;

const readJson = (rel, fallback = null) => {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`[mobile-payload] ${rel} is unreadable: ${e.message}`);
    return fallback;
  }
};

const round = (n, places = 5) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

// ---------------------------------------------------------------------------
// Geometry substitution
// ---------------------------------------------------------------------------

/**
 * Resolve the geometry keys `buildAllRoutesPaths` emits as descriptors.
 *
 * On the web these are fetched lazily — 1.8 MB of static polyline JSON plus
 * Overpass round-trips, on every session. Here they are read from the committed
 * caches once, so the app never learns these routes are special.
 *
 * `useRoutePaths` also applies OSM_TRIM_OFFSETS, which is `{}` today; if entries
 * ever appear there they must be mirrored here.
 */
function loadSubstituteGeometry() {
  const byKey = new Map();

  const staticFiles = {
    "static:enHumenne": "public/data/enHumennePolyline.json",
    "static:zemplin": "public/data/zemplinPolyline.json",
    "static:rjChop": "public/data/rjChopPolyline.json",
    "static:rj1038": "public/data/rj1038Polyline.json",
    "static:przemyslSwinoujscie":
      "public/data/przemyslSwinoujsciePolyline.json",
  };
  for (const [key, rel] of Object.entries(staticFiles)) {
    const coords = readJson(rel);
    if (Array.isArray(coords) && coords.length > 0) byKey.set(key, coords);
  }

  for (const file of fs.readdirSync(path.join(ROOT, "public/data/scraped"))) {
    const match = /^osm-(\d+)\.json$/.exec(file);
    if (!match) continue;
    // The scrape stores `{ uploadedAt, data }`; the Overpass response is inside.
    const envelope = readJson(`public/data/scraped/${file}`);
    const overpass = envelope?.data ?? envelope;
    const coords = overpass && relationCoordsFromOverpass(overpass, match[1]);
    if (Array.isArray(coords) && coords.length > 0) byKey.set(match[1], coords);
  }

  return byKey;
}

// ---------------------------------------------------------------------------
// Date-dependent inputs (see the header: inputs, never verdicts)
// ---------------------------------------------------------------------------

const ISO_DAY = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/**
 * Every service window this route's trips declare, plus whether *all* of them
 * declare one. `isRouteOutsideServiceIdSeason` only hides a route when every
 * trip is bounded and all windows have passed, so the app needs both facts.
 */
function seasonInputs(routeId, trips) {
  const routeTrips = Object.values(trips).filter(
    (t) => t.route_id?.toString() === routeId.toString(),
  );
  if (routeTrips.length === 0) return { ranges: [], allBounded: false };

  const ranges = [];
  let allBounded = true;
  for (const trip of routeTrips) {
    const range = parseBoTServiceIdDateRange(trip.service_id);
    if (!range) {
      allBounded = false;
      continue;
    }
    ranges.push([ISO_DAY(range.start), ISO_DAY(range.end)]);
  }
  return { ranges, allBounded };
}

/**
 * Candidate opening dates from trip irregularities, unfiltered by today.
 * `getFutureRouteStartDate` picks the earliest one still ahead; the app does the
 * same, against its own clock.
 */
function futureStartCandidates(routeId, trips) {
  const routeTrips = Object.values(trips).filter(
    (t) => t.route_id?.toString() === routeId.toString(),
  );
  const dates = new Set();
  for (const trip of routeTrips) {
    const text = trip.irregularities;
    if (!text || typeof text !== "string") continue;
    for (const m of text.matchAll(/From\s+(\d{4}-\d{2}-\d{2})/gi)) {
      dates.add(m[1]);
    }
    for (const m of text.matchAll(/postponed\s+to\s+(\d{4})/gi)) {
      dates.add(`${m[1]}-01-01`);
    }
  }
  return [...dates].sort();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build({ tolerance = DEFAULT_TOLERANCE_DEG } = {}) {
  const envelope = readJson("public/data/published/initial-data.json");
  if (!envelope?.data) {
    throw new Error(
      "public/data/published/initial-data.json is missing or malformed — run `npm run canonicalize` first.",
    );
  }

  const disabledRoutes = readJson("data/overrides/disabled-routes.json", []);

  // The API applies this at request time, so a payload built straight off the
  // published file would resurrect routes the admin has retired.
  const stripped = stripDisabledRoutes(envelope.data, disabledRoutes);

  const enriched = enrichInitialData({
    data: stripped,
    pkpBundle: readJson("public/data/gtfs/pkpTrainShapes.json"),
    rjChopData: readJson("public/data/gtfs/rjChopTimetable.json"),
    rjPremyslData: readJson("public/data/gtfs/rjPremyslTimetable.json"),
    onWarn: (msg, e) => console.warn(`[mobile-payload] ${msg}: ${e.message}`),
  });

  const { stops, cities, viewMapData, trips } = enriched;

  // -- routes and geometry -------------------------------------------------
  const paths = buildAllRoutesPaths({
    viewMapData,
    stops,
    cities,
    trips,
    stationsToSkip,
    normalizeStationNameForLookup,
  });

  // A route hidden by today's season filter never reaches `paths`, so its
  // geometry would be missing from the payload and the app could not un-hide it
  // later. Nothing is seasonal today; trip if that changes rather than shipping
  // a silent gap.
  const seasonallyHidden = Object.values(viewMapData)
    .map((r) => r.route_id?.toString())
    .filter((id) => id && isRouteOutsideServiceIdSeason(id, trips));
  if (seasonallyHidden.length > 0) {
    throw new Error(
      `${seasonallyHidden.length} route(s) are outside their service season today ` +
        `(${seasonallyHidden.slice(0, 5).join(", ")}), so buildAllRoutesPaths omits their ` +
        `geometry. The payload carries seasonRanges for the app to re-evaluate, which only ` +
        `works if the geometry is present. Emit geometry for hidden routes before shipping this.`,
    );
  }

  const substitutes = loadSubstituteGeometry();
  const unresolved = new Set();
  let pointsIn = 0;
  let pointsOut = 0;

  const geomByRoute = new Map();
  for (const p of paths) {
    let positions = p.positions;
    if (p.osmRelationId) {
      const sub = substitutes.get(p.osmRelationId);
      if (sub?.length > 0) positions = sub;
      else unresolved.add(p.osmRelationId);
    }

    const stroke = encodeStroke(positions, tolerance);
    if (!stroke) continue;
    pointsIn += stroke.pointsIn;
    pointsOut += stroke.pointsOut;

    const routeId = p.routeId?.toString();
    if (!geomByRoute.has(routeId)) geomByRoute.set(routeId, []);
    const entry = { p: stroke.encoded };
    if (p.isBusConnector) {
      entry.bus = true;
      if (p.busFrom) entry.from = p.busFrom;
      if (p.busTo) entry.to = p.busTo;
    }
    geomByRoute.get(routeId).push(entry);
  }

  // pathOptions is per-stroke on the web but constant per route (it is derived
  // from the route, not the stroke), so it is lifted onto the route here. One
  // consequence worth knowing: `buildRouteColorMap` shades by an operator's
  // route *count*, so the web gives a route a different shade when only one
  // station's routes are on screen. Baking one colour per route makes it stable
  // across views — a change, and an improvement.
  const styleByRoute = new Map();
  for (const p of paths) {
    const routeId = p.routeId?.toString();
    if (!styleByRoute.has(routeId)) styleByRoute.set(routeId, p.pathOptions);
  }

  const routes = [];
  for (const row of Object.values(viewMapData)) {
    const id = row.route_id?.toString();
    if (!id) continue;
    const geom = geomByRoute.get(id);
    if (!geom || geom.length === 0) continue;

    const style = styleByRoute.get(id) || {};
    const agency = row.bot_agency_id || row.agency_id || "";
    const season = seasonInputs(id, trips);

    const dirs = [];
    for (const d of [0, 1]) {
      const from = row[`origin_trip_${d}`];
      const to = row[`destination_trip_${d}`];
      if (!from || !to) continue;

      const trip = Object.values(trips).find(
        (t) =>
          t.route_id?.toString() === id &&
          t.trip_short_name?.toString() ===
            row[`trip_short_name_${d}`]?.toString(),
      );

      dirs.push({
        d,
        train: row[`trip_short_name_${d}`] || null,
        from,
        to,
        dep: row[`origin_departure_time_${d}`] || null,
        arr: row[`destination_arrival_time_${d}`] || null,
        service: row[`service_id_${d}`] || null,
        via: (row[`via_${d}`] || "")
          .split(" - ")
          .map((s) => s.trim())
          .filter(Boolean),
        irregularities: row[`irregularities_${d}`] || null,
        duration: trip?.duration ?? null,
        distance: trip?.distance ?? null,
        co2: trip?.emissions_co2e ?? null,
        classes: trip?.classes ?? null,
        amenities: trip
          ? {
              catering: trip.catering ?? null,
              plugs: trip.plugs ?? null,
              wheelchair: trip.wheelchair_accessible ?? null,
              bikes: trip.bikes_allowed ?? null,
              car: trip.car_transport ?? null,
            }
          : null,
        // Booking templates are per-operator with {origin}/{dest} holes; filling
        // them here means the app ships no URL-building code and no override file.
        booking:
          buildBookingUrl({ agencyId: agency, origin: from, dest: to }) || null,
      });
    }
    if (dirs.length === 0) continue;

    routes.push({
      id,
      agency,
      feedAgency: row.agency_id || null,
      color: style.color || null,
      weight: style.weight ?? null,
      opacity: style.opacity ?? null,
      dash: parseDashArray(style.dashArray),
      picture: row.picture || null,
      pricing: row.pricing || null,
      deals: getDealsLink(agency) || null,
      hasUnknownStart: hasUnknownStart(id, trips),
      drawAsActive: shouldDrawFutureRouteAsActive(row),
      seasonRanges: season.ranges,
      seasonBounded: season.allBounded,
      futureStarts: futureStartCandidates(id, trips),
      dirs,
      geom,
    });
  }

  // -- stations and city groups -------------------------------------------
  // Only stations a route actually touches: the published `stops` array carries
  // 29,749 rail stations, of which ~1,700 appear on a sleeper route. The rest is
  // 2.7 MB the app would parse and never draw.
  const routeStations = stops.filter((s) => {
    const key = normalizeStationNameForLookup(s.stop_id);
    return Boolean((cities[key] || cities[s.stop_id])?.stop_route_ids);
  });

  const stationIndex = new Map();
  const stations = routeStations.map((s, i) => {
    const info =
      cities[normalizeStationNameForLookup(s.stop_id)] ||
      cities[s.stop_id] ||
      {};
    stationIndex.set(s.stop_id, i);
    return {
      n: s.stop_id,
      y: round(s.stop_lat),
      x: round(s.stop_lon),
      r: [...new Set((info.stop_route_ids || "").split(",").filter(Boolean))],
      m: info.isMainStation ? 1 : 0,
    };
  });

  // Both toggle states are precomputed: clustering does not depend on the
  // viewport, only on the isGrouped boolean, so it is 2 states rather than
  // 120 lines of union-find in Dart.
  const grouped = groupCityMarkers(
    routeStations,
    cities,
    true,
    normalizeStationNameForDisplay,
    normalizeStationNameForLookup,
  );
  const groups = grouped.map((g) => ({
    n: g.displayName,
    y: round(g.stop_lat),
    x: round(g.stop_lon),
    // Indices into `stations`, so a tapped group can list its members without
    // the payload repeating them.
    s: (g.groupedStations || [g])
      .map((m) => stationIndex.get(m.stop_id))
      .filter((i) => i !== undefined),
    m: g.isGrouped ? 1 : 0,
  }));

  return {
    payload: {
      v: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      dataUploadedAt: envelope.uploadedAt || null,
      sources: envelope.sources || {},
      alwaysShow: alwaysShowStations,
      stations,
      groups,
      routes,
    },
    stats: {
      paths: paths.length,
      routes: routes.length,
      stations: stations.length,
      groups: groups.length,
      droppedStops: stops.length - routeStations.length,
      pointsIn,
      pointsOut,
      unresolved: [...unresolved],
    },
  };
}

function main() {
  const { payload, stats } = build();
  const json = JSON.stringify(payload);
  const gzip = zlib.gzipSync(Buffer.from(json), { level: 9 }).length;

  const sections = {
    stations: JSON.stringify(payload.stations).length,
    groups: JSON.stringify(payload.groups).length,
    geometry: payload.routes.reduce(
      (a, r) => a + JSON.stringify(r.geom).length,
      0,
    ),
  };
  sections.routeMeta =
    JSON.stringify(payload.routes).length - sections.geometry;

  console.log("[mobile-payload]");
  console.log(
    `  routes            ${stats.routes} (from ${stats.paths} strokes)`,
  );
  console.log(
    `  stations          ${stats.stations} (dropped ${stats.droppedStops} unused)`,
  );
  console.log(`  city groups       ${stats.groups}`);
  console.log(
    `  geometry points   ${stats.pointsIn} → ${stats.pointsOut} ` +
      `(${(100 - (stats.pointsOut / stats.pointsIn) * 100).toFixed(0)}% simplified away)`,
  );
  console.log(`  geometry          ${kb(sections.geometry)}`);
  console.log(`  route metadata    ${kb(sections.routeMeta)}`);
  console.log(`  stations+groups   ${kb(sections.stations + sections.groups)}`);
  console.log(`  TOTAL             ${kb(json.length)} raw / ${kb(gzip)} gzip`);

  if (stats.unresolved.length > 0) {
    console.warn(
      `  WARNING unresolved geometry keys: ${stats.unresolved.join(", ")} — ` +
        `those routes fall back to their station-chain path.`,
    );
  }

  if (json.length > MAX_RAW_BYTES) {
    console.error(
      `\n[mobile-payload] ${kb(json.length)} exceeds the ${kb(MAX_RAW_BYTES)} budget.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, json);
  console.log(`  written           ${path.relative(ROOT, OUT_FILE)}`);
}

export { build };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
