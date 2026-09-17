// scripts/adapters/cfr-gtfs.mjs
// CFR Călători (Romania) from the Romanian national railway GTFS feed.
//
// Why this exists: Romania publishes the timetable as XML on data.gov.ro, and
// the adapter that read it (scripts/adapters/cfr.mjs, deleted with this change)
// was never reachable from the nightly runner. It failed 14 nights running with
// `lastSuccessAt: null` — it never once produced data, so every Romanian route
// on the map still ran on Back-on-Track's hand-maintained via lists.
//
// The same timetable arrives as GTFS through the Mobility Database
// (`mdb-3236`, Transitous' conversion of the S.C. Informatică Feroviară open
// data), on the exact `mobilitydata-datasets-prod/<id>/latest.zip` alias that
// already feeds European Sleeper nightly. It is strictly richer than the XML:
// coordinates on all 1 695 stops, real `shapes.txt` track geometry, per-date
// calendars, and the operator's own night-train category `IR-N` (InterRegio de
// Noapte) — which is the sleeper allowlist, rather than a heuristic over it.
//
// Two things the feed does NOT give, and they shape everything below.
//
// 1. It stops at the national border. IR-N 346 "Dacia" ends at Lokoshaza, not
//    Wien; 401 starts at Ungheni, not Chişinău. So a row's foreign stretch has
//    to be spliced back on from Back-on-Track, which is the only place we have
//    it. Without the splice `updateVia` would REPLACE Back-on-Track's Budapest
//    and Győr with nothing and the drawn line would stop at the frontier.
//
// 2. Its keys are its own ("IR-N 346"), not Back-on-Track's ("D 346"), and a
//    through car is two feed routes for one row ("IRN 472/IRN 1743"). Both are
//    handled in the allowlist by `{ route | routes, name }` (see gtfs.mjs),
//    which keys each train by the label the trainsByNumber enrichment looks a
//    row up by.
//
// The endpoint check is what makes `setTimes` safe here. A spliced train ends
// where its row ends, carrying the row's own endpoint times on the foreign
// ends, so writing times back is a correction on the Romanian end and a no-op
// on the other. A train whose endpoints do NOT line up is dropped rather than
// enriched — a reused number on another corridor must not overwrite a row.

import path from "node:path";
import fs from "node:fs";
import polyline from "@mapbox/polyline";
import {
  downloadGtfs,
  loadGtfsDir,
  buildSleeperTrains,
  stationNameCanonicalizer,
} from "../lib/gtfs.mjs";
import { resolveCanonicalStationName } from "../../src/pages/api/lib/primitives.mjs";
import { splitViaString } from "../../src/lib/viaSplit.mjs";

/** A committed scrape artifact, for what ctx.shared may not carry yet. */
function readScraped(rootDir, name) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(rootDir, "public/data/scraped", name), "utf8"),
    );
    return raw?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Comparison key for a station name across the spellings this source has to
 * reconcile: the feed's, Back-on-Track's and Hungary's. "Bucuresti Nord" =
 * "Bucuresti Nord" with diacritics, "Timisoara Nord" = cedilla-s = comma-s,
 * "Cluj Napoca" = "Cluj-Napoca", "Lokoshaza" = "Lokoshaza" with accents. NFD
 * alone does not do it: s-comma and t-comma decompose, but Polish l-stroke and
 * Croatian d-stroke are single code points with no combining form.
 *
 * Deliberately not `normLabel` from gtfs.mjs, which strips every non-ASCII
 * letter outright instead of folding it: that turns "Istanbul Halkali" spelled
 * with a dotless i into "istanbul halkal", so a name written with the dotless
 * form on one side only would silently stop matching.
 */
export function foldStationName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/ş/g, "s")
    .replace(/ţ/g, "t")
    .replace(/ș/g, "s")
    .replace(/ț/g, "t")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bh\.\s*/g, " ")
    .replace(/\bhm\.\s*/g, " ")
    .replace(/[.,'’"()]/g, " ")
    .replace(/[-–—/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadAllowlist(configPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed?.routes;
  if (!Array.isArray(list)) {
    throw new Error(`allowlist ${configPath} must be an array or { routes: [...] }`);
  }
  return list;
}

/** Back-on-Track's own chain for one direction: origin, its via list, destination. */
export function botChain(route, d, isKnownStation) {
  const origin = route?.[`origin_trip_${d}`];
  const destination = route?.[`destination_trip_${d}`];
  if (!origin || !destination) return [];
  return [
    origin,
    ...splitViaString(route[`via_${d}`], isKnownStation),
    destination,
  ].filter(Boolean);
}

/**
 * Put the feed's Romanian stop list back inside its row's full journey.
 *
 * The head is every Back-on-Track station before the first one the feed also
 * carries, the tail every station after the last — so a train the feed covers
 * end to end is returned untouched, and one truncated at a border regains
 * exactly the part the feed could not know about.
 *
 * Returns null when the two share no station at all: the feed is then talking
 * about a different journey and the row keeps Back-on-Track's everything.
 */
export function spliceForeignStretch({ stations, route, d, isKnownStation, stopCoords }) {
  const chain = botChain(route, d, isKnownStation);
  if (chain.length < 2 || !stations.length) return null;

  const feedFolded = new Set(stations.map((s) => foldStationName(s.name)));
  const hits = chain
    .map((name, i) => (feedFolded.has(foldStationName(name)) ? i : -1))
    .filter((i) => i >= 0);
  if (!hits.length) return null;

  // A Back-on-Track station the feed does not carry, as a station record. No
  // times: a via name has none, and inventing one is worse than a blank. The
  // endpoints are the exception — the row states those itself.
  //
  // A station with no coordinate is KEPT, with a null location. Four of row
  // 28's Bulgarian via names (Svilengrad, Stara Zagora, Veliko Tarnovo, Gorna
  // Oryahovitsa) are not in Back-on-Track's station table at all — they are
  // text in a via string and nothing else, so they have never had a map dot.
  // Dropping them here would have made the enriched list SHORTER than the one
  // it replaces: the row lost four real place names and viaOnlyIfRicher then
  // refused the whole train, which is how this surfaced. Everything downstream
  // that needs a position already checks for one (build-initial-data's
  // synthetic path filters on Number.isFinite), and the callers below skip
  // them when chaining geometry.
  const asStation = (name, { departure = null, arrival = null } = {}) => {
    const coords = stopCoords(name);
    return {
      name,
      code: null,
      location: coords ? { latitude: coords.lat, longitude: coords.lon } : null,
      arrival,
      departure,
      pickup: true,
      dropoff: true,
    };
  };

  const head = chain
    .slice(0, hits[0])
    .map((name, i) =>
      asStation(name, i === 0 ? { departure: route[`origin_departure_time_${d}`] } : {}),
    )
    .filter(Boolean);
  const tailNames = chain.slice(hits[hits.length - 1] + 1);
  const tail = tailNames
    .map((name, i) =>
      asStation(
        name,
        i === tailNames.length - 1
          ? { arrival: route[`destination_arrival_time_${d}`] }
          : {},
      ),
    )
    .filter(Boolean);

  return { stations: [...head, ...stations, ...tail], head: head.length, tail: tail.length };
}

/**
 * Does a built train end where its row does?
 *
 * Deliberately a strict name comparison, folded for diacritics and separators
 * (so "Cluj Napoca" matches "Cluj-Napoca" and cedilla-s matches comma-s) and
 * nothing looser. A city-level fallback was tried and removed: it never fired
 * on any of the 36 entries, and the one case it would have changed is one it
 * must not — Budapest Keleti and Budapest Kelenfold are different stations, and
 * a train that ends at one does not end at the other. This check is what makes
 * setTimes safe, so it is the wrong place to be generous.
 */
export function endpointsAgree(stations, route, d) {
  const same = (a, b) => Boolean(a && b && foldStationName(a) === foldStationName(b));
  return (
    same(stations[0]?.name, route[`origin_trip_${d}`]) &&
    same(stations[stations.length - 1]?.name, route[`destination_trip_${d}`])
  );
}

export async function run(entry, ctx) {
  const { feedUrl, configPath, agency, operator } = entry.params ?? {};
  if (!feedUrl || !configPath) {
    throw new Error(`${entry.id}: params.feedUrl and params.configPath are required`);
  }
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const allowlist = loadAllowlist(path.join(ctx.rootDir, configPath));

  const manualDir = process.env[`${entry.id.toUpperCase().replace(/-/g, "_")}_GTFS_DIR`];
  const gtfsDir = manualDir
    ? path.resolve(ctx.rootDir, manualDir)
    : path.join(ctx.rootDir, "gtfs-data", `${entry.id}-unpacked`);
  if (!manualDir) {
    log(`downloading ${feedUrl}`);
    await downloadGtfs(feedUrl, gtfsDir);
  }

  const gtfs = loadGtfsDir(gtfsDir);
  const stats = {};
  const trains = buildSleeperTrains({
    gtfs,
    allowlist,
    agency: agency || entry.synthetic?.agency?.value || entry.id,
    operator: operator || entry.label,
    log,
    stats,
    stationRenames: entry.synthetic?.stationRenames,
    canonicalizeName: stationNameCanonicalizer(entry.params, resolveCanonicalStationName),
  });

  if (Object.keys(trains).length === 0 && stats.feedRouteCount > 0) {
    throw new Error(
      `${entry.id}: 0 of ${stats.feedRouteCount} feed routes matched the allowlist — feed naming may have changed (unmatched: ${(stats.unmatched || []).join(", ")})`,
    );
  }

  // ─── Splice the foreign stretch back on, then check the endpoints ─────────
  // The runner only hydrates ctx.shared from disk AFTER the source loop, and in
  // a full run this adapter happens to run after backontrack has filled it. Both
  // are accidents of ordering, and the second one hides the first: a filtered
  // run (SCRAPE_ONLY=cfr, which is exactly how a branch previews this source)
  // saw an empty view map, spliced nothing, and published D 346 as
  // "Bucuresti Nord -> Wien Hbf, arriving 03:00" — Lokoshaza's time on Vienna's
  // marker, with Budapest and Gyor gone from the line. So read the committed
  // file ourselves when it is not already there.
  const viewMap = ctx.shared?.viewMap ?? readScraped(ctx.rootDir, "backontrack-view_ontd_map.json") ?? {};
  const botStops = ctx.shared?.stops ?? readScraped(ctx.rootDir, "backontrack-stops.json") ?? {};
  if (!Object.keys(viewMap).length) {
    throw new Error(
      `${entry.id}: no Back-on-Track view map available — refusing to publish an unspliced feed`,
    );
  }
  const coordIndex = new Map();
  for (const stop of Object.values(botStops)) {
    if (!stop?.stop_name) continue;
    if (!Number.isFinite(stop.stop_lat) || !Number.isFinite(stop.stop_lon)) continue;
    const key = foldStationName(stop.stop_name);
    if (!coordIndex.has(key)) coordIndex.set(key, { lat: stop.stop_lat, lon: stop.stop_lon });
  }
  const stopCoords = (name) => coordIndex.get(foldStationName(name)) ?? null;
  const isKnownStation = (name) => Boolean(stopCoords(name));

  // label → the row/direction it belongs to, so a train knows its own journey.
  const rowByLabel = new Map();
  for (const route of Object.values(viewMap)) {
    for (const d of [0, 1]) {
      const label = route[`trip_short_name_${d}`];
      if (label && !rowByLabel.has(String(label).trim())) {
        rowByLabel.set(String(label).trim(), { route, d });
      }
    }
  }

  let spliced = 0;
  let dropped = 0;
  for (const [key, train] of Object.entries(trains)) {
    const hit = rowByLabel.get(train.lineName);
    // No row: a synthetic-only sleeper from the allowlist's extras. Nothing to
    // splice against and nothing to contradict, so it stands on the feed alone.
    if (!hit) continue;
    const { route, d } = hit;

    const joined = spliceForeignStretch({
      stations: train.stations,
      route,
      d,
      isKnownStation,
      stopCoords,
    });
    if (!joined) {
      log(`drop ${train.lineName}: shares no station with its Back-on-Track row`);
      delete trains[key];
      dropped++;
      continue;
    }
    if (!endpointsAgree(joined.stations, route, d)) {
      log(
        `drop ${train.lineName}: ends ${joined.stations[0]?.name} → ${joined.stations[joined.stations.length - 1]?.name}, row says ${route[`origin_trip_${d}`]} → ${route[`destination_trip_${d}`]}`,
      );
      delete trains[key];
      dropped++;
      continue;
    }
    if (joined.head || joined.tail) {
      spliced++;
      train.stations = joined.stations;
      // Re-encode the line, or the row keeps a polyline that stops at the
      // frontier while its stop list runs on to Wien — the drawn route would
      // end in the middle of nowhere with markers beyond it. The feed's shape
      // is kept for the Romanian stretch and the foreign stations are chained
      // straight, which is still far better than the 2-7 via points the row
      // draws today.
      const spine = polyline.decode(train.polyline);
      const chainOf = (list) =>
        list
          .filter((st) => Number.isFinite(st?.location?.latitude))
          .map((st) => [st.location.latitude, st.location.longitude]);
      train.polyline = polyline.encode([
        ...chainOf(joined.stations.slice(0, joined.head)),
        ...spine,
        ...chainOf(
          joined.tail ? joined.stations.slice(joined.stations.length - joined.tail) : [],
        ),
      ]);
      train.coverage = "partial";
    }
  }

  const built = Object.keys(trains).length;
  log(
    `built ${built} train(s) — ${spliced} spliced past the border, ${dropped} dropped on an endpoint mismatch`,
  );
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
}
