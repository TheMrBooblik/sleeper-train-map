// lib/build-initial-data.mjs
// Pure merge of all night-train sources into the legacy { stops, viewMap, trips }
// payload served by /api/initial-data. Extracted verbatim from the former
// in-route logic so the live API and the build-time canonicalize script
// (scripts/canonicalize.mjs) share one code path — output is identical by
// construction. ESM/.mjs so raw `node` can run it; no external dependencies.

import {
  inAgencyScope,
  isActiveRecord,
  isTrain4you,
  resolveCanonicalStationName,
  routeIdsReferencedInTrips,
  routeIdsFromFilteredTrips,
  keepViewMapRowForTripActivity,
} from "./primitives.mjs";
import { sameTrainAsRow } from "../../../lib/sameTrain.mjs";
import { upcomingDepartureForTrain } from "../../../lib/nextDeparture.mjs";

// Source registry: declares per-source synthetic-route config (id prefix,
// agency, aliasing, dedup strategy). Bundled via ESM JSON import so the
// lambda build traces it (same pattern as station-aliases in primitives.mjs).
import SOURCE_REGISTRY from "../../../../data/sources/registry.json" with { type: "json" };
// Per-route from-prices, curated through the review queue (price.update
// proposals). Stamped onto viewMap rows + trips; getOperatorPricing() picks
// the route-level record up before falling back to operator defaults.
import ROUTE_PRICES from "../../../../data/canonical/prices.json" with { type: "json" };
// Operator pricing defaults — provides the fixed/dynamic `type` half of the
// stamped record so the existing badge keeps rendering.
import OPERATOR_PRICING from "../../../../data/overrides/operator-pricing.json" with { type: "json" };
// Manually verified station coordinates (see normalizeStops). Same file the
// browser already applied through src/data/stationCoordinates.js.
import STATION_COORDINATES from "../../../../data/overrides/station-coordinates.json" with { type: "json" };
// TEMPORARY route previews: hand-authored future re-routings we want to show
// ahead of Back-on-Track publishing them (e.g. the 14-Dec European Sleeper
// 456/457 path). Each entry injects a synthetic viewMap row + trips and can
// retire the route it supersedes once its date arrives. Delete the file entry
// (and this import stays harmless with an empty array) once BoT carries it.
import FUTURE_PREVIEWS from "../../../../data/overrides/future-route-previews.json" with { type: "json" };

const identity = (name) => name;

// Inject hand-authored future route variants and, once their start date has
// arrived, hide the route they replace. The injected trips carry a
// "From YYYY-MM-DD" irregularity, so the existing client-side future-ghost
// logic fades them until the date and turns them solid afterwards — no
// render-layer changes needed. This runs AFTER the review gate so previews are
// never withheld.
function applyFutureRoutePreviews(viewMap, trips, stops, now, previews) {
  for (const preview of previews ?? []) {
    if (!preview?.id || !preview.row) continue;
    // Add the variant row + its trips (keyed so they never collide with BoT).
    viewMap[preview.id] = { ...preview.row };
    for (const [tripKey, trip] of Object.entries(preview.trips ?? {})) {
      trips[tripKey] = { ...trip };
    }
    // Hand-authored stops for via points the dataset lacks (e.g. Dutch Breda),
    // so the new calling points still render as markers. Skip names already
    // present to avoid duplicates.
    for (const stop of preview.extraStops ?? []) {
      if (!stop?.stop_id) continue;
      const exists = stops.some((s) => s.stop_id === stop.stop_id);
      if (!exists) stops.push({ ...stop });
    }
    // Informational "about this route" link, shown in the detail panel. Stamp it
    // onto both the new variant and the route it replaces (same service), so the
    // existing via-Liège line gets the link too.
    if (preview.infoUrl) {
      viewMap[preview.id].info_url = preview.infoUrl;
      const superseded = viewMap[preview.supersedesRouteId];
      if (superseded) superseded.info_url = preview.infoUrl;
    }
    // Tickets already on sale before the first running day: keep full map
    // opacity and only surface the start date on hover (see shouldDrawFutureRouteAsActive).
    if (preview.drawAsActive) {
      viewMap[preview.id].draw_as_active = true;
      const superseded = viewMap[preview.supersedesRouteId];
      if (superseded) superseded.draw_as_active = true;
    }
    // Once the new routing is live, retire the routing it replaces so the same
    // train never shows two physical paths at once.
    const startsAt = preview.activeFrom ? Date.parse(preview.activeFrom) : NaN;
    if (
      preview.supersedesRouteId &&
      Number.isFinite(startsAt) &&
      now.getTime() >= startsAt
    ) {
      const superseded = viewMap[preview.supersedesRouteId];
      if (superseded) superseded.is_active = "N";
    }
  }
}

// ─── Operator filtering ──────────────────────────────────────────────────────

// NJ/EN are kept here so they render as Back-on-Track routes initially; the
// client filters them out once official NightJet/EuroNight data loads.
function filterTrips(data) {
  const filtered = {};
  Object.entries(data || {}).forEach(([key, trip]) => {
    if (!isActiveRecord(trip)) return;
    const tripName = (
      trip?.trip_short_name ||
      trip?.route_short_name ||
      ""
    ).toString();
    const isT4y = isTrain4you(trip, tripName);
    if (!isT4y) {
      filtered[key] = trip.via ? { ...trip, via: sanitizeVia(trip.via) } : trip;
    }
  });
  return filtered;
}

// BoT source data misspells the Polish city "Katowice" as "Katovice" in some
// via fields. "Katovice" (Czech village near Písek) resolves to wrong coordinates
// and wrong display text. Fix both by substituting at the data level.
function sanitizeVia(str) {
  if (!str) return str;
  return str.replace(/\bKatovice\b/g, "Katowice");
}

// view_ontd_map rows often lack is_active; trips.json is authoritative per
// service. If every trip for a route_id is inactive (filtered out), hide the row.
function filterViewMap(data, rawTrips, filteredTrips) {
  const referencedIds = routeIdsReferencedInTrips(rawTrips);
  const visibleIds = routeIdsFromFilteredTrips(filteredTrips);
  const filtered = {};
  Object.entries(data || {}).forEach(([key, route]) => {
    if (!isActiveRecord(route)) return;
    const trip0 = (route?.trip_short_name_0 || "").toString();
    const trip1 = (route?.trip_short_name_1 || "").toString();
    // Drop malformed rows with no train identity (e.g. an all-empty BoT row):
    // real and synthetic rows always carry a train number, so a row missing both
    // can't render and must never reach the map.
    if (!trip0.trim() && !trip1.trim()) return;
    const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
    const rowOk = !isT4y;
    if (
      !keepViewMapRowForTripActivity(
        rowOk,
        route?.route_id,
        referencedIds,
        visibleIds,
      )
    ) {
      return;
    }
    filtered[key] = {
      ...route,
      via_0: sanitizeVia(route.via_0),
      via_1: sanitizeVia(route.via_1),
    };
  });
  return filtered;
}

// ─── Stops ─────────────────────────────────────────────────────────────────

// Manually verified coordinates beat Back-on-Track's, which are sometimes not
// merely imprecise but somewhere else entirely: its Norwegian stops are all
// stamped country NO while geocoded across Europe — "Tverlandet" on the Basque
// coast, "Voss" in Germany, "Stjørdal" in Czechia, "Trondheim Airport Værnes"
// in Stockholm. Nothing showed it until the Entur feed replaced 2–6 via points
// with the operator's full stop list, because a station no route names never
// gets a marker to be wrong in.
//
// The override table existed for exactly this ("values which are sometimes
// wrong") but was applied only in the browser, in useInitialData via
// enrichStationsWithCoordinates, so the SEO corridor maps have been drawing
// every one of its entries at the coordinate it exists to replace. Doing it
// here puts one set of coordinates in the payload; the client pass then agrees
// with it instead of diverging from it.
//
// Keyed by stop_id and by stop_name because 703 records spell the two
// differently, the same reason the payload projection matches on both.
function overrideCoords(stop, byKey) {
  const hit =
    byKey.get(String(stop?.stop_id ?? "").toLowerCase().trim()) ??
    byKey.get(String(stop?.stop_name ?? "").toLowerCase().trim());
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function normalizeStops(rawStops, coordOverrides = STATION_COORDINATES) {
  const stopsArray = Array.isArray(rawStops)
    ? rawStops
    : Object.values(rawStops || {});
  const byKey = new Map(
    Object.entries(coordOverrides || {}).map(([name, v]) => [
      name.toLowerCase().trim(),
      v,
    ]),
  );
  return stopsArray.map((s) => {
    const fixed = byKey.size ? overrideCoords(s, byKey) : null;
    return {
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: fixed ? fixed.lat : s.stop_lat,
      stop_lon: fixed ? fixed.lon : s.stop_lon,
    };
  });
}

// NightJet stations: keyed by exact name (first occurrence), stored under their
// canonical Back-on-Track name so synthetic routes reference NJ coordinates.
// `gate` (optional) records every injected candidate and can veto unapproved
// ones — the review-queue gate for brand-new station markers.
function injectNJStations(trimmedStops, stopNameSet, njTrains, gate) {
  const njStationsByName = new Map();
  Object.values(njTrains).forEach((train) => {
    (train.stations ?? []).forEach((s) => {
      if (
        s?.name &&
        Number.isFinite(s?.location?.latitude) &&
        Number.isFinite(s?.location?.longitude) &&
        !njStationsByName.has(s.name)
      ) {
        njStationsByName.set(s.name, s);
      }
    });
  });
  njStationsByName.forEach((njStation) => {
    const canonicalName = resolveCanonicalStationName(njStation.name);
    if (stopNameSet.has(canonicalName.toLowerCase())) return;
    gate?.record(canonicalName);
    if (gate && !gate.isAllowed(canonicalName)) return;
    trimmedStops.push({
      stop_id: canonicalName,
      stop_name: canonicalName,
      stop_lat: njStation.location.latitude,
      stop_lon: njStation.location.longitude,
    });
    stopNameSet.add(canonicalName.toLowerCase());
  });
}

// Generic station injection (raw names) for CR / Italian / Caucasus trains.
function injectTrainStations(trimmedStops, stopNameSet, trains, gate) {
  Object.values(trains).forEach((train) => {
    (train.stations ?? []).forEach((s) => {
      if (
        !s?.name ||
        !Number.isFinite(s?.location?.latitude) ||
        !Number.isFinite(s?.location?.longitude)
      ) return;
      if (stopNameSet.has(s.name.toLowerCase())) return;
      gate?.record(s.name);
      if (gate && !gate.isAllowed(s.name)) return;
      trimmedStops.push({
        stop_id: s.name,
        stop_name: s.name,
        stop_lat: s.location.latitude,
        stop_lon: s.location.longitude,
      });
      stopNameSet.add(s.name.toLowerCase());
    });
  });
}

// Disambiguate colliding station names within one source's trains (e.g. the US
// "Vancouver, WA" vs Canada's "Vancouver"). Applied before station injection and
// route building so the injected marker and the route's derived
// origin/destination/via all use the same (renamed) name. Geometry is untouched.
function applyStationRenames(trains, renames) {
  const keys = renames && typeof renames === "object" ? Object.keys(renames) : [];
  if (keys.length === 0) return trains;
  const lower = new Map(keys.map((k) => [k.toLowerCase(), renames[k]]));
  const out = {};
  for (const [key, train] of Object.entries(trains)) {
    const stations = Array.isArray(train?.stations) ? train.stations : null;
    if (!stations) { out[key] = train; continue; }
    let changed = false;
    const renamed = stations.map((s) => {
      const to = s?.name ? lower.get(String(s.name).toLowerCase()) : null;
      if (to && to !== s.name) { changed = true; return { ...s, name: to }; }
      return s;
    });
    out[key] = changed ? { ...train, stations: renamed } : train;
  }
  return out;
}

// ─── Synthetic routes ────────────────────────────────────────────────────────

// Builds synthetic view_ontd_map rows from a list of [lineName, data] trains
// with decoded polylines, pairing each direction with its reverse where found.
// Shared by NJ, Chinese, Italian and Caucasus sources; per-source differences
// are passed as options.
/**
 * Reverse-direction partners for synthetic trains, period-aware: lineName ->
 * the lineName of its return. Same-period pairs first (both running now, or
 * both on sale for a later run), then whatever is left pairs across periods,
 * each pass in feed order so the result is stable between builds.
 */
function pairByPeriod(trainList, resolveName, nextDeparture) {
  const ends = new Map(
    trainList.map(([k, v]) => [
      k,
      {
        from: resolveName(v.stations?.[0]?.name),
        to: resolveName(v.stations?.[v.stations.length - 1]?.name),
        later: Boolean(upcomingDepartureForTrain(v, { timeZone: nextDeparture.timeZone })),
      },
    ]),
  );
  const partnerOf = new Map();
  for (const samePeriodOnly of [true, false]) {
    for (const [k] of trainList) {
      if (partnerOf.has(k)) continue;
      const a = ends.get(k);
      const match = trainList.find(([j]) => {
        if (j === k || partnerOf.has(j)) return false;
        const b = ends.get(j);
        return b.from === a.to && b.to === a.from && (!samePeriodOnly || b.later === a.later);
      });
      if (match) {
        partnerOf.set(k, match[0]);
        partnerOf.set(match[0], k);
      }
    }
  }
  return partnerOf;
}

function appendSyntheticRoutes(
  viewMap,
  trainList,
  {
    idPrefix,
    agency,
    resolveName,
    withService = false,
    botAgencyByTrain = {},
    sourceId = null,
    nextDeparture = null,
    seasonByTrain = {},
  },
) {
  // A train the source dates only by its next run, when that run is weeks off
  // (synthetic.nextDeparture, nightjet.com): `next_departure_{dir}` plus the
  // season the replaced Back-on-Track row last ran. Stamped only when the run
  // is more than UPCOMING_AFTER_DAYS out, so a running train's row does not
  // change every night. src/lib/nextDeparture.mjs reads both.
  const stampNextRun = (row, dir, lineName, train) => {
    if (!nextDeparture) return;
    const date = upcomingDepartureForTrain(train, { timeZone: nextDeparture.timeZone });
    if (!date) return;
    row[`next_departure_${dir}`] = date;
    if (seasonByTrain[lineName]) row[`previous_service_${dir}`] = seasonByTrain[lineName];
  };
  // A journey time the source states outright (`durationMinutes`), because
  // two endpoint clocks cannot express more than a day: Vietnam's SE1 runs
  // 32h45 and its clocks read 21:45 → 06:30. Every reader that measures a
  // row's journey takes this first (routeDurationMinutes, the plan legs).
  const stampDuration = (row, dir, train) => {
    const n = Number(train?.durationMinutes);
    if (Number.isInteger(n) && n > 0) row[`duration_minutes_${dir}`] = n;
  };
  const paired = new Set();
  // The row shows a train as its source names it (`lineName`) and looks it up
  // by its key in the trains file. The two differ only where one number is
  // several journeys: Trenitalia's ICN 1963 runs Milano → Catania and, as a
  // through-car portion, Milano → Palermo, keyed "ICN 1963" and "ICN 1963
  // (Palermo)" but sold as ICN 1963 both. Then the key rides along as
  // `train_key_{dir}`, which every lookup reads first (rowTrainKey).
  const label = (key, train) => {
    const name = typeof train?.lineName === "string" ? train.lineName.trim() : "";
    return name || key;
  };
  const stampLabel = (row, dir, key, train) => {
    row[`trip_short_name_${dir}`] = label(key, train);
    if (row[`trip_short_name_${dir}`] !== key) row[`train_key_${dir}`] = key;
  };
  // Which train is whose return. A corridor can carry this timetable's train
  // and next period's under other numbers, and pairing each train with the
  // first reverse train in feed order joins the wrong ones: nightjet.com lists
  // NJ 448 Wien→Brussels (running now) and NJ 449 Brussels→Wien (from
  // February), and that order put them on one row — NJ 449's answer carries
  // no polyline, so the map drew next February's Frankfurt routing as
  // straight lines over the train that runs tonight. Where the source dates
  // its trains by their next run (synthetic.nextDeparture), trains are paired
  // within their own period first and across periods only from what is left,
  // so a February train cannot take the partner of one running tonight
  // (NJ 429 had taken NJ 420 from NJ 421). Without it, the old greedy order.
  const partnerOf = nextDeparture ? pairByPeriod(trainList, resolveName, nextDeparture) : null;
  trainList.forEach(([lineName, data]) => {
    if (paired.has(lineName)) return;
    const origin = resolveName(data.stations[0].name);
    const dest = resolveName(data.stations[data.stations.length - 1].name);
    const reversePair = partnerOf
      ? partnerOf.has(lineName)
        ? trainList.find(([k]) => k === partnerOf.get(lineName) && !paired.has(k))
        : undefined
      : trainList.find(
          ([k, v]) =>
            k !== lineName &&
            !paired.has(k) &&
            resolveName(v.stations?.[0]?.name) === dest &&
            resolveName(v.stations?.[v.stations.length - 1]?.name) === origin,
        );
    const safeId = lineName.replace(/\s+/g, "_");
    // Who runs the row: a train that states its own carrier (agency_id, from a
    // source with synthetic.agency.from "data") decides it, from either
    // direction — nightjet.com names a partner EuroNight's carrier per train.
    const stated = [data, reversePair?.[1]].find((t) => t?.agency_id) ?? data;
    const rowAgency = agency(stated);
    // BoT's operator attribution for the row this synthetic route replaced
    // (either direction) — e.g. "PKP/ČD" for a partner EuroNight. Consumed by
    // the operator display in the panel, which reads it before agency_id. Left
    // off when the source itself named the carrier: the joint id would then
    // contradict the carrier the source named, on the very surfaces that
    // read it first.
    const carrierStated = [data, reversePair?.[1]].some(
      (t) => t?.agencyFrom && t.agencyFrom !== "home",
    );
    const botAgency = carrierStated
      ? null
      : botAgencyByTrain[lineName] ||
        (reversePair ? botAgencyByTrain[reversePair[0]] : null) ||
        null;
    const entry = {
      route_id: `${idPrefix}${safeId}`,
      agency_id: rowAgency,
      ...(botAgency ? { bot_agency_id: botAgency } : {}),
      trip_short_name_0: lineName,
      origin_trip_0: origin,
      destination_trip_0: dest,
      via_0: data.stations
        .slice(1, -1)
        .map((s) => resolveName(s.name))
        .filter(Boolean)
        .join(" - "),
      route_long_name: `${origin} – ${dest}`,
      ...(withService ? { service_id_0: data.frequency || null } : {}),
      nj_polyline_0: data.polyline || null,
      is_active: "Y",
      // Which registry source built this row. A synthetic row has no trips in
      // the Back-on-Track table, so the detail panel reads its timetable from
      // that source's own trains file (/api/operator-trains?source=…) instead
      // of from a per-operator feed it would otherwise have to hardcode.
      ...(sourceId ? { timetable_source: sourceId } : {}),
    };
    stampLabel(entry, 0, lineName, data);
    stampNextRun(entry, 0, lineName, data);
    stampDuration(entry, 0, data);
    if (reversePair) {
      const [revName, revData] = reversePair;
      stampLabel(entry, 1, revName, revData);
      entry.origin_trip_1 = resolveName(revData.stations[0].name);
      entry.destination_trip_1 = resolveName(
        revData.stations[revData.stations.length - 1].name,
      );
      entry.via_1 = revData.stations
        .slice(1, -1)
        .map((s) => resolveName(s.name))
        .filter(Boolean)
        .join(" - ");
      if (withService) entry.service_id_1 = revData.frequency || null;
      entry.nj_polyline_1 = revData.polyline || null;
      stampNextRun(entry, 1, revName, revData);
      stampDuration(entry, 1, revData);
      paired.add(revName);
    }
    paired.add(lineName);
    viewMap[entry.route_id] = entry;

    // The upcoming timetable, when the source already knows it (a GTFS feed
    // usually carries the next period months ahead). It rides along as its own
    // row so the map can show today's routing and the one that replaces it side
    // by side, the way the hand-authored future-route previews used to. Once the
    // nightly scrape crosses the change date this period becomes `data` and the
    // extra row disappears on its own.
    const future = data.future;
    const revFuture = reversePair?.[1]?.future;
    if (future?.activeFrom && future.stations?.length >= 2) {
      const fOrigin = resolveName(future.stations[0].name);
      const fDest = resolveName(future.stations[future.stations.length - 1].name);
      const futureEntry = {
        route_id: `${entry.route_id}_from_${future.activeFrom.replace(/-/g, "")}`,
        agency_id: rowAgency,
        ...(botAgency ? { bot_agency_id: botAgency } : {}),
        trip_short_name_0: lineName,
        origin_trip_0: fOrigin,
        destination_trip_0: fDest,
        via_0: future.stations
          .slice(1, -1)
          .map((s) => resolveName(s.name))
          .filter(Boolean)
          .join(" - "),
        route_long_name: `${fOrigin} – ${fDest} (from ${formatActiveFrom(future.activeFrom)})`,
        ...(withService ? { service_id_0: future.frequency || null } : {}),
        nj_polyline_0: future.polyline || null,
        is_active: "Y",
        ...(sourceId ? { timetable_source: sourceId } : {}),
        // Tickets are already on sale for the new timetable, so it draws at full
        // opacity with the start date on hover — not as a faded ghost.
        draw_as_active: true,
      };
      stampLabel(futureEntry, 0, lineName, data);
      if (revFuture?.stations?.length >= 2) {
        stampLabel(futureEntry, 1, reversePair[0], reversePair[1]);
        futureEntry.origin_trip_1 = resolveName(revFuture.stations[0].name);
        futureEntry.destination_trip_1 = resolveName(
          revFuture.stations[revFuture.stations.length - 1].name,
        );
        futureEntry.via_1 = revFuture.stations
          .slice(1, -1)
          .map((s) => resolveName(s.name))
          .filter(Boolean)
          .join(" - ");
        if (withService) futureEntry.service_id_1 = revFuture.frequency || null;
        futureEntry.nj_polyline_1 = revFuture.polyline || null;
      }
      viewMap[futureEntry.route_id] = futureEntry;
    }
  });
}

// "2026-12-14" → "14 Dec", for the "(from …)" suffix on an upcoming timetable.
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatActiveFrom(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1] ?? m[2]}`;
}

function withPolylineAndStations([, data]) {
  return data.polyline && data.stations?.length >= 2;
}

// ─── Per-source BoT-row dedup strategies ─────────────────────────────────────
// When official operator data covers a train, the matching (stale) Back-on-Track
// row is dropped in favour of the synthetic route built from the official data.
// Each strategy returns { officialTrainKey: botAgencyId } for the dropped rows,
// so the synthetic replacement can keep BoT's operator attribution (partner
// EuroNight trains are operated by e.g. PKP/ČD, not by the ÖBB default the
// synthetic source carries for styling).

// "exact": BoT trip_short_name matches the official train key verbatim (NJ/EN)
// AND the train ends in one of the row's end cities (sameTrainAsRow). The
// number alone is not enough: nightjet.com's EN 442 runs Budapest–Stuttgart
// while Back-on-Track's is ČD's Humenné–Praha, and deleting that row lost a
// train nobody else carries. A row the official train is not is kept, and
// its number then counts as Back-on-Track's (excludeBotMatched), so the two
// trains never share one number on the map.
// `seasonByTrain`, when given, collects each dropped direction's own service
// string: a seasonal train the official source only knows by its next run
// (nightjet.com's EN 1276/1277, next run June 2027) keeps the season it last
// ran as `previous_service_{dir}` on the synthetic row (see nextDeparture.mjs).
function dropBotRowsExact(filteredViewMap, trains, seasonByTrain = null) {
  const botAgencyByTrain = {};
  Object.keys(filteredViewMap).forEach((key) => {
    const route = filteredViewMap[key];
    const names = [route?.trip_short_name_0, route?.trip_short_name_1]
      .map((n) => (n || "").trim())
      .filter((n) => n && trains[n] && sameTrainAsRow(route, trains[n]));
    if (!names.length) return;
    const botAgency = (route?.agency_id || "").trim();
    if (botAgency) for (const n of names) botAgencyByTrain[n] = botAgency;
    if (seasonByTrain) {
      for (const dir of [0, 1]) {
        const name = (route?.[`trip_short_name_${dir}`] || "").trim();
        const service = (route?.[`service_id_${dir}`] || "").trim();
        if (name && service && names.includes(name)) seasonByTrain[name] = service;
      }
    }
    delete filteredViewMap[key];
  });
  return botAgencyByTrain;
}

// "icn": BoT uses "IC Notte 770"; our data uses "ICN 770" — compare bare numbers.
function dropBotRowsIcn(filteredViewMap, trains, idPrefix) {
  const bareNumber = (n) =>
    n.replace(/^IC\s+Notte\s+/i, "").replace(/\s*\([^)]*\)$/, "").trim();
  const apiKeyByBareNumber = new Map(
    Object.keys(trains).map((n) => [n.replace(/^ICN\s+/i, "").trim(), n]),
  );
  const botAgencyByTrain = {};
  Object.keys(filteredViewMap).forEach((key) => {
    if (key.startsWith(idPrefix)) return;
    const route = filteredViewMap[key];
    const t0 = bareNumber((route?.trip_short_name_0 || "").toString());
    const t1 = bareNumber((route?.trip_short_name_1 || "").toString());
    if (apiKeyByBareNumber.has(t0) || apiKeyByBareNumber.has(t1)) {
      const botAgency = (route?.agency_id || "").trim();
      if (botAgency) {
        for (const t of [t0, t1]) {
          const apiKey = apiKeyByBareNumber.get(t);
          if (apiKey) botAgencyByTrain[apiKey] = botAgency;
        }
      }
      delete filteredViewMap[key];
    }
  });
  return botAgencyByTrain;
}

const DEDUP_STRATEGIES = {
  exact: (viewMap, trains, _synthetic, seasonByTrain) =>
    dropBotRowsExact(viewMap, trains, seasonByTrain),
  icn: (viewMap, trains, synthetic) =>
    dropBotRowsIcn(viewMap, trains, synthetic.idPrefix),
};

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Merge all sources into the legacy serving payload. Per-source behaviour
 * (id prefix, agency, station aliasing, BoT dedup) comes from the registry's
 * `synthetic` config — adding an operator is a registry entry, not code here.
 *
 * @param {object} inputs
 * @param {object|Array} inputs.stops    Raw Back-on-Track stops
 * @param {object} inputs.viewMap        Raw Back-on-Track view_ontd_map
 * @param {object} inputs.trips          Raw Back-on-Track trips
 * @param {object} [inputs.operatorTrains] Trains per source id, e.g.
 *   { nightjet: { "NJ 237": {polyline, stations}, ... }, chinese: {...}, ... }
 * @param {Array}  [inputs.registry]     Source registry (defaults to bundled)
 * @param {object} [inputs.seenIndex]    Approval index (data/canonical/state/
 *   seen.json). When provided, routes/stations not approved yet are withheld
 *   from the payload — the "verify before it goes live" gate. When null
 *   (default), everything flows: callers that can't load the index (or
 *   pre-gate callers like the parity test) must never blank the map.
 * @param {object} [inputs.stats]        Optional out-param; filled with
 *   { injectedStations: string[], stationSources: {name: sourceId},
 *   gatedRouteKeys: string[] } for the nightly classifier.
 * @returns {{ stops: Array, viewMap: object, trips: object }}
 */
export function buildInitialData({
  stops,
  viewMap,
  trips,
  operatorTrains = {},
  registry = SOURCE_REGISTRY,
  seenIndex = null,
  routePrices = ROUTE_PRICES,
  futurePreviews = FUTURE_PREVIEWS,
  now = new Date(),
  stats = null,
} = {}) {
  const filteredTrips = filterTrips(trips);
  const filteredViewMap = filterViewMap(viewMap, trips, filteredTrips);

  const trimmedStops = normalizeStops(stops);
  const stopNameSet = new Set(
    trimmedStops.map((s) => (s.stop_id || "").toLowerCase()),
  );

  // Station gate: records every injected candidate (for the classifier) and
  // withholds markers for stations the admin hasn't approved yet.
  const injectedStations = [];
  const stationSources = {};
  const injectedSeen = new Set();
  const gate = {
    record(name, sourceId) {
      if (!injectedSeen.has(name)) {
        injectedSeen.add(name);
        injectedStations.push(name);
        if (sourceId) stationSources[name] = sourceId;
      }
    },
    isAllowed(name) {
      if (!seenIndex) return true;
      return seenIndex.injectedStations?.[name]?.approved === true;
    },
  };

  for (const entry of registry) {
    const synthetic = entry?.synthetic;
    if (!synthetic || !entry.enabled) continue;
    let trains = operatorTrains[entry.id] ?? {};
    if (synthetic.stationRenames) {
      trains = applyStationRenames(trains, synthetic.stationRenames);
    }

    const dedup = DEDUP_STRATEGIES[synthetic.dedupStrategy];
    const seasonByTrain = {};
    const botAgencyByTrain = dedup
      ? dedup(filteredViewMap, trains, synthetic, seasonByTrain) || {}
      : {};

    // Source attribution for the classifier's trusted-station auto-approval.
    const gateForEntry = {
      record: (name) => gate.record(name, entry.id),
      isAllowed: (name) => gate.isAllowed(name),
    };
    if (synthetic.resolveAliases) {
      injectNJStations(trimmedStops, stopNameSet, trains, gateForEntry);
    } else {
      injectTrainStations(trimmedStops, stopNameSet, trains, gateForEntry);
    }

    let trainList = Object.entries(trains).filter(withPolylineAndStations);
    if (synthetic.excludeBotMatched) {
      // Only add synthetic routes for trains BoT doesn't already cover
      // (computed after dedup, so surviving BoT rows win).
      const botMatched = new Set();
      Object.entries(filteredViewMap)
        .filter(
          ([key, route]) =>
            // Never let our own synthetic rows answer "does BoT cover this?" —
            // the scrape runner's leftover rows carry this source's idPrefix and
            // would otherwise mark every train as covered, shadowing the richer
            // row appendSyntheticRoutes builds below (same rule as dropBotRowsIcn).
            !key.startsWith(synthetic.idPrefix) &&
            inAgencyScope(route, synthetic.botMatchAgencies),
        )
        .forEach(([, route]) => {
          [route.trip_short_name_0, route.trip_short_name_1]
            .filter(Boolean)
            .forEach((n) => botMatched.add(n.trim()));
        });
      trainList = trainList.filter(([lineName]) => !botMatched.has(lineName));
    }

    appendSyntheticRoutes(filteredViewMap, trainList, {
      idPrefix: synthetic.idPrefix,
      agency:
        synthetic.agency?.from === "data"
          ? (data) => data.agency_id || synthetic.agency.fallback
          : () => synthetic.agency?.value,
      resolveName: synthetic.resolveAliases ? resolveCanonicalStationName : identity,
      withService: !!synthetic.withService,
      botAgencyByTrain,
      sourceId: entry.id,
      nextDeparture: synthetic.nextDeparture ?? null,
      seasonByTrain,
    });
  }

  // Review gate: withhold routes the admin hasn't approved. Keys absent from
  // the index are new tonight (the classifier runs after this and files a
  // proposal) — default-deny so nothing unreviewed reaches the map.
  const gatedRouteKeys = [];
  if (seenIndex) {
    for (const key of Object.keys(filteredViewMap)) {
      if (seenIndex.routes?.[key]?.approved !== true) {
        gatedRouteKeys.push(key);
        delete filteredViewMap[key];
      }
    }
  }

  // Per-route from-prices (review-queue curated): stamp onto the route row and
  // its trips so getOperatorPricing(routeOrTrip) resolves them route-first.
  for (const [key, price] of Object.entries(routePrices ?? {})) {
    const row = filteredViewMap[key];
    if (!row || !Number.isFinite(price?.fromPrice)) continue;
    const operatorDefault = OPERATOR_PRICING[(row.agency_id || "").trim()] ?? null;
    const pricing = {
      type: operatorDefault?.type ?? null,
      currency: price.currency ?? operatorDefault?.currency ?? "EUR",
      fromPrice: price.fromPrice,
      source: price.source ?? null,
      // When the figure was last confirmed. The probe records this and it was
      // being dropped here, so nothing downstream could say how old a price
      // was. It matters most for a hand-entered one: "from €29" with no date is
      // indistinguishable from the same number typed two years ago, and a fare
      // that has moved since makes the page wrong rather than merely stale.
      checkedAt: price.sampledAt ?? null,
    };
    row.pricing = pricing;
    for (const [tripKey, trip] of Object.entries(filteredTrips)) {
      if (String(trip.route_id) === String(key)) {
        // Copy — trips without a via pass through filterTrips unchanged, and
        // mutating those would leak into the caller's raw input.
        filteredTrips[tripKey] = { ...trip, pricing };
      }
    }
  }

  if (stats) {
    stats.injectedStations = injectedStations;
    stats.stationSources = stationSources;
    stats.gatedRouteKeys = gatedRouteKeys;
  }

  // Temporary hand-authored future re-routings (see import note). After the
  // gate so they always render; date-driven fade/activate is handled client-side.
  applyFutureRoutePreviews(
    filteredViewMap,
    filteredTrips,
    trimmedStops,
    now,
    futurePreviews,
  );

  stampTimetableSources(filteredViewMap, registry);
  stampOfficialFares(filteredViewMap, filteredTrips, operatorTrains, registry);
  stampPunctuality(filteredViewMap, operatorTrains, registry);
  stampEndpointCountries(filteredViewMap, stops);
  stampScheduleOriginCodes(filteredViewMap, operatorTrains, registry);

  return {
    stops: trimmedStops,
    viewMap: filteredViewMap,
    trips: filteredTrips,
  };
}

/**
 * Name the trains file that holds a corroborated row's official timetable.
 *
 * The enrichment rewrites a Back-on-Track row from an official feed and stamps
 * `official_sources`, but the detail panel builds its cards from the trips
 * table and so had only the row's via names to list — Trafiklab's SJ 91 showed
 * its 13 stops with a time at each end and none between, while the feed it came
 * from times every one. `timetable_source` is the first stamping source that
 * enriches by train number (and therefore has a trains file keyed by the row's
 * labels); the panel reads that file the way it reads a synthetic row's own.
 * A bundle-based source (PKP) is skipped: it has no trains file, and its
 * per-stop times already reach the panel through pkp_schedule_*.
 */
function stampTimetableSources(viewMap, registry) {
  const byTrains = new Set(
    (registry ?? [])
      .filter((e) => e?.enabled && e.output && e.enrich?.strategy === "trainsByNumber")
      .map((e) => e.id),
  );
  for (const route of Object.values(viewMap)) {
    if (route.timetable_source) continue;
    const sources = Array.isArray(route.official_sources) ? route.official_sources : [];
    const hit = sources.find((id) => byTrains.has(id));
    if (hit) route.timetable_source = hit;
  }
}

/**
 * Stamp the fare an official source scraped tonight onto the row that source
 * built. A figure read nightly from the operator's own booking system needs
 * no reviewer, and it outranks a reviewed data/canonical/prices.json entry
 * (stamped above), which is the fallback for routes no official source
 * prices. `official` is the bar, not `trusted`: trust is about letting a
 * source create routes unreviewed, while a fare only ever lands on a row
 * that already passed the gate.
 *
 * A train carries `fare: { fromPrice, currency, seatClass, sampledAt, travelDate? }` in its
 * trains file (the chinese adapter writes it from 12306's queryTicketPrice).
 * The row takes the cheaper of its two directions, and only rows whose
 * timetable_source is that source are touched, so a bare number another
 * operator shares cannot lend its price across.
 */
/**
 * The key a row's direction is filed under in its source's trains file: the
 * label it shows (`trip_short_name_{dir}`), unless one number is several
 * journeys and the row names the key apart (`train_key_{dir}`, set by
 * appendSyntheticRoutes — "ICN 1963 (Palermo)" behind a row labelled
 * "ICN 1963"). Every lookup of a row's train in a trains file goes through it.
 */
export function rowTrainKey(row, dir) {
  return row?.[`train_key_${dir}`] || row?.[`trip_short_name_${dir}`];
}

export function stampOfficialFares(viewMap, trips, operatorTrains, registry) {
  const sources = new Map(
    (registry ?? [])
      .filter((e) => e?.enabled && e.official && operatorTrains?.[e.id])
      .map((e) => [e.id, operatorTrains[e.id]]),
  );
  if (!sources.size) return 0;
  let stamped = 0;
  for (const [key, row] of Object.entries(viewMap)) {
    const trains = sources.get(row.timetable_source);
    if (!trains) continue;
    const fares = [];
    for (const dir of [0, 1]) {
      const fare = trains[rowTrainKey(row, dir)]?.fare;
      if (!Number.isFinite(fare?.fromPrice) || fare.fromPrice <= 0 || !fare.currency) continue;
      fares.push({ ...fare, trainName: row[`trip_short_name_${dir}`] });
      // Each direction keeps its own figure and berth classes: a card about
      // one train shows that train's price (src/lib/fareClasses.mjs).
      row[`fare_${dir}`] = {
        fromPrice: fare.fromPrice,
        currency: fare.currency,
        seatClass: fare.seatClass ?? null,
        ...(fare.classes && typeof fare.classes === "object" ? { classes: fare.classes } : {}),
        // Each class's own cheapest night (scripts/lib/fare-calendar.mjs
        // cheapestNight), and where the cheapest last-minute deal is sold.
        ...(fare.classDates && typeof fare.classDates === "object" ? { classDates: fare.classDates } : {}),
        ...(fare.dealLanding ? { dealLanding: fare.dealLanding } : {}),
        // A published tariff's range (SNCF's tarifs-intercites): each class's
        // maximum beside its minimum in `classes`, and what kind of figure it
        // is, so the pages can print "€39–€75" and say whose range it is.
        ...(fare.classMax && typeof fare.classMax === "object" ? { classMax: fare.classMax } : {}),
        ...(fare.basis ? { basis: fare.basis } : {}),
        ...(fare.tariffModified ? { tariffModified: fare.tariffModified } : {}),
        source: row.timetable_source,
        checkedAt: fare.sampledAt ?? null,
        // The night the figure was quoted for. A yield-managed fare
        // (lefrecce) is one date's price; a fixed tariff (12306) has none.
        ...(fare.travelDate ? { travelDate: fare.travelDate } : {}),
      };
      // Every night's fare, when the source keeps a calendar (lefrecce does:
      // scripts/lib/fare-calendar.mjs). Read by the connection pages only —
      // the map payload drops it (stripPageOnlyFields).
      const calendar = trains[rowTrainKey(row, dir)]?.fareCalendar;
      if (calendar?.nights && Object.keys(calendar.nights).length) {
        row[`fare_calendar_${dir}`] = calendar;
      }
    }
    if (!fares.length) {
      // `fare: null` on every train the row names is the source saying it
      // does not price them: nightjet.com sells partner EuroNights but its
      // figures are not the carrier's (scripts/lib/nj-fares.mjs
      // njPricesTrain). The row then gets an empty pricing record, so
      // resolvePricing stops at it instead of reaching the carrier's
      // operator-pricing default — PKP's says "Domestic tariff", which a
      // München–Przemyśl EuroNight is not.
      const names = [rowTrainKey(row, 0), rowTrainKey(row, 1)].filter(Boolean);
      if (names.length && names.every((n) => trains[n] && trains[n].fare === null)) {
        const pricing = { type: null, currency: null, fromPrice: null, source: row.timetable_source };
        row.pricing = pricing;
        for (const [tripKey, trip] of Object.entries(trips ?? {})) {
          if (String(trip.route_id) === String(key)) trips[tripKey] = { ...trip, pricing };
        }
      }
      continue;
    }
    // Never compare across currencies; the first direction's currency decides.
    const sameCurrency = fares.filter((f) => f.currency === fares[0].currency);
    const cheapest = sameCurrency.reduce((a, b) => (b.fromPrice < a.fromPrice ? b : a));
    const operatorDefault = OPERATOR_PRICING[(row.agency_id || "").trim()] ?? null;
    const pricing = {
      type: operatorDefault?.type ?? null,
      currency: cheapest.currency,
      fromPrice: cheapest.fromPrice,
      source: row.timetable_source,
      checkedAt: cheapest.sampledAt ?? null,
      ...(cheapest.travelDate ? { travelDate: cheapest.travelDate } : {}),
      // Which train the figure is: the row's is the cheaper direction's, and
      // a tile quoting it beside a timetable of both must say which one.
      ...(cheapest.trainName ? { trainName: cheapest.trainName } : {}),
      ...(cheapest.seatClass ? { seatClass: cheapest.seatClass } : {}),
      ...(cheapest.basis ? { basis: cheapest.basis } : {}),
    };
    row.pricing = pricing;
    for (const [tripKey, trip] of Object.entries(trips ?? {})) {
      if (String(trip.route_id) === String(key)) trips[tripKey] = { ...trip, pricing };
    }
    stamped++;
  }
  return stamped;
}

/**
 * Copy each direction's punctuality from the official trains file that times
 * the row (`timetable_source`) onto `punctuality_{dir}`. Today only SNCF
 * writes it (scripts/lib/sncf-open-data.mjs), from SNCF's monthly AQST
 * regularity figures, and only for a train whose origin–destination no
 * daytime Intercités shares. Keyed by the row's own train label like the fare,
 * so a bare number another operator shares cannot lend its figure across.
 * Read by the connection pages only — the map payload drops it
 * (stripPageOnlyFields).
 */
export function stampPunctuality(viewMap, operatorTrains, registry) {
  const official = new Set((registry ?? []).filter((e) => e?.enabled && e.official).map((e) => e.id));
  let stamped = 0;
  for (const row of Object.values(viewMap ?? {})) {
    if (!official.has(row.timetable_source)) continue;
    const trains = operatorTrains?.[row.timetable_source];
    if (!trains) continue;
    for (const dir of [0, 1]) {
      const value = trains[rowTrainKey(row, dir)]?.punctuality;
      if (!value || !Number.isFinite(value.onTimeRate)) continue;
      row[`punctuality_${dir}`] = value;
      stamped++;
    }
  }
  return stamped;
}

/**
 * Record, per direction, the operator's own id for that train's origin station.
 *
 * Some operators address a train on their site by station code rather than by
 * name: Trenitalia's per-train page is
 * cercaTreno.jsp?treno=1962&origine=S12349&datapartenza=…, where S12349 is
 * Viaggiatreno's id for Siracusa and is not derivable from the station name.
 * The scrape already sees those ids (the adapter fetches andamentoTreno per
 * station code), so the code travels with the train rather than being
 * hand-maintained — an operator's station ids are theirs to renumber.
 *
 * Keyed off each direction's own train, because the return leg starts
 * somewhere else: ICN 1962 leaves Siracusa, ICN 1963 leaves Milano Centrale.
 * Silent by design — a train the sources don't carry leaves the field unset and
 * the schedule link falls back a tier rather than building a broken URL.
 *
 * And kept per source, in that source's own agency scope, because a bare train
 * number is only unique within an operator — the collision this codebase has
 * now met in four places. Flattening every source's trains into one map by
 * number put an Entur quay id (`NSR:Quay:1080`, Trondheim S) on European
 * Sleeper's ES 475 row the moment Norway was added, since SJ Nord runs a 475
 * too. Nothing rendered wrong yet, only because no Vy or SJ Nord URL template
 * names {originCode} — which is exactly the kind of latent wrong data that
 * becomes a broken link the day someone adds one.
 *
 * A source that declares no scope stamps any row, as elsewhere; that stays
 * right for operator-prefixed keys and is why the registry's Norwegian entries
 * carry agencyIds.
 */
function stampScheduleOriginCodes(viewMap, operatorTrains, registry) {
  const perSource = [];
  for (const entry of registry || []) {
    const trains = operatorTrains?.[entry.id];
    if (!trains) continue;
    const codes = new Map();
    for (const [name, train] of Object.entries(trains)) {
      const code = train?.stations?.[0]?.code;
      if (code && !codes.has(name)) codes.set(name, code);
    }
    if (!codes.size) continue;
    perSource.push({
      codes,
      scope: entry.enrich?.agencyIds ?? entry.synthetic?.botMatchAgencies ?? null,
    });
  }
  if (perSource.length === 0) return;

  for (const row of Object.values(viewMap)) {
    for (const { codes, scope } of perSource) {
      if (!inAgencyScope(row, scope)) continue;
      for (const dir of [0, 1]) {
        const code = codes.get(rowTrainKey(row, dir));
        if (code) row[`schedule_origin_code_${dir}`] = code;
      }
    }
  }
}

/**
 * Record each route's endpoint countries on its viewMap row.
 *
 * The published stops payload carries only id/name/lat/lon — country lives on
 * the raw Back-on-Track stop and is dropped by normalizeStops(), so the map's
 * detail panel has no way to tell which country a route reaches. Two ISO-2
 * codes per direction is a few bytes a row and saves shipping stop_country for
 * all ~29k stops, which is what per-country schedule links (Nightjet's
 * destination pages) need to resolve client-side.
 *
 * Silent by design: a station missing from the index leaves the field unset and
 * the schedule link falls back a tier, which is why this never throws.
 */
function stampEndpointCountries(viewMap, rawStops) {
  const byName = new Map();
  const stopsArray = Array.isArray(rawStops)
    ? rawStops
    : Object.values(rawStops || {});
  for (const s of stopsArray) {
    const name = s?.stop_name;
    const country = s?.stop_country;
    if (name && country && !byName.has(name)) byName.set(name, country);
  }
  if (byName.size === 0) return;

  for (const row of Object.values(viewMap)) {
    for (const dir of [0, 1]) {
      const origin = byName.get(row[`origin_trip_${dir}`]);
      const dest = byName.get(row[`destination_trip_${dir}`]);
      if (origin) row[`origin_country_${dir}`] = origin;
      if (dest) row[`destination_country_${dir}`] = dest;
    }
  }
}

/**
 * Remove admin-disabled routes from an already-built payload. Applied at
 * /api/initial-data serve time (against both the published fast path and the
 * fallback merge) so toggling a route off/on in the admin Routes tab takes
 * effect on the next redeploy and is fully reversible — the published artifact
 * still carries every row, this just withholds the disabled ones per request.
 *
 * @param {{stops:Array, viewMap:object, trips:object}} payload
 * @param {string[]} disabledRouteIds  route_id keys to withhold
 * @returns {{stops:Array, viewMap:object, trips:object}} a new payload
 */
export function stripDisabledRoutes(payload, disabledRouteIds) {
  const disabled = new Set((disabledRouteIds ?? []).map(String));
  if (disabled.size === 0 || !payload) return payload;

  const viewMap = {};
  for (const [key, row] of Object.entries(payload.viewMap ?? {})) {
    if (!disabled.has(String(key))) viewMap[key] = row;
  }

  const trips = {};
  for (const [tripKey, trip] of Object.entries(payload.trips ?? {})) {
    if (!disabled.has(String(trip?.route_id))) trips[tripKey] = trip;
  }

  return { ...payload, viewMap, trips };
}
