// scripts/adapters/oncf.mjs
// ONCF (Office National des Chemins de Fer) — Morocco's two overnight
// corridors, both running nightly in each direction with couchettes (4 berths)
// and single/double sleeper cabins:
//
//   Marrakech ↔ Tanger-Ville   (~10h20, via Casablanca and Sidi Kacem)
//   Casa-Voyageurs ↔ Oujda     (~10h,   via Fès and Taza)
//
// There is no usable GTFS. The only published feed (MobilityDatabase mdb-3049,
// producer github.com/newsbubbles/rail_maroc_oncf) is community-built, expired
// 2025-12-31, and contains ZERO overnight trips — its `AL_ATLAS_CASA_OUJDA` and
// `AL_BORAQ_TNG_MKC` routes are declared with no trips at all. Do not wire it in.
//
// PROBE-GATED: the dev sandbox cannot reach any oncf.ma / oncf-voyages.ma host,
// so the parser below is finalized from CI findings. Run the "Probe ONCF source"
// workflow (scripts/probe-oncf.mjs), inspect the artifact to see which surface
// carries the timetable — the oncf-voyages.ma booking API (switch the registry
// entry to kind:"json-api"), the official timetable downloads, or the legacy
// /fr/Horaires search — implement parseScheduleHtml() accordingly, then flip the
// registry entry to enabled:true. Until a strategy yields journeys, run() throws:
// runner error isolation plus the sticky merge keep yesterday's data live and the
// failure visible in the scrape log and /data dashboard.

import fs from "node:fs";
import path from "node:path";
import { emptyGeometryCache, resolveRouteGeometry } from "../lib/route-geometry.mjs";
// Generic (botStops + overrides) coordinate resolver — shared rather than copied.
// If a third adapter needs it, promote it to scripts/lib/.
import { makeStationResolver } from "./europeansleeper.mjs";
import { relationCoordsFromOverpass } from "../../src/pages/api/lib/osm-geo.mjs";
import { renderCalendar } from "../../src/pages/api/lib/calendar.mjs";

const GEOMETRY_CACHE_FILE = "route-geometry.json";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

// ONCF internal station identifiers used by the schedule search
// (code_r 0093 = rail, 0011 = Supratours coaches — rail only here).
export const STATION_CODES = {
  MARRAKECH: { code_r: "0093", code_g: "00110" },
  BENGUERIR: { code_r: "0093", code_g: "00120" },
  SETTAT: { code_r: "0093", code_g: "00139" },
  "CASA VOYAGEURS": { code_r: "0093", code_g: "00200" },
  "RABAT AGDAL": { code_r: "0093", code_g: "00229" },
  "RABAT VILLE": { code_r: "0093", code_g: "00231" },
  SALE: { code_r: "0093", code_g: "00237" },
  KENITRA: { code_r: "0093", code_g: "00250" },
  "SIDI KACEM": { code_r: "0093", code_g: "00350" },
  ASILAH: { code_r: "0093", code_g: "00317" },
  TANGER: { code_r: "0093", code_g: "00303" },
  MEKNES: { code_r: "0093", code_g: "00363" },
  FES: { code_r: "0093", code_g: "00380" },
  TAZA: { code_r: "0093", code_g: "00431" },
  TAOURIRT: { code_r: "0093", code_g: "00451" },
  OUJDA: { code_r: "0093", code_g: "00490" },
};

// The overnight corridors to query. `stops` is the expected calling order and
// doubles as the fallback station chain when only endpoints come back.
export const NIGHT_CORRIDORS = [
  {
    id: "marrakech-tanger",
    from: "MARRAKECH",
    to: "TANGER",
    stops: [
      "MARRAKECH", "BENGUERIR", "SETTAT", "CASA VOYAGEURS", "RABAT AGDAL",
      "RABAT VILLE", "SALE", "KENITRA", "SIDI KACEM", "ASILAH", "TANGER",
    ],
  },
  {
    id: "casablanca-oujda",
    from: "CASA VOYAGEURS",
    to: "OUJDA",
    stops: [
      "CASA VOYAGEURS", "RABAT AGDAL", "RABAT VILLE", "SALE", "KENITRA",
      "SIDI KACEM", "MEKNES", "FES", "TAZA", "TAOURIRT", "OUJDA",
    ],
  },
];

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** dd/mm/yyyy, the format the schedule search expects. */
export function formatSearchDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/**
 * Legacy server-rendered schedule search URL. Kept exported and pure so the
 * probe and the tests can exercise it without network access.
 */
export function buildScheduleSearchUrl(base, fromName, toName, date, time = "20:00") {
  const f = STATION_CODES[fromName];
  const t = STATION_CODES[toName];
  if (!f || !t) return null;
  return (
    `${base}?from[${f.code_g}][${f.code_r}]=${encodeURIComponent(fromName)}` +
    `&to[${t.code_g}][${t.code_r}]=${encodeURIComponent(toName)}` +
    `&datedep=${encodeURIComponent(formatSearchDate(date))}+${encodeURIComponent(time)}` +
    "&dateret=&is-ar=0"
  );
}

/**
 * Normalize parsed journeys into the standard trains-file shape.
 * Journeys: [{ train, stops: [{name, arrival: "HH:MM"|null, departure}],
 * calendar: string | calendar.mjs object | null }]
 */
export function normalizeOncfTrains(journeys, { resolveStation, today }) {
  const trains = {};
  for (const j of journeys ?? []) {
    const name = String(j?.train ?? "").trim();
    if (!name || !(j?.stops?.length >= 2)) continue;
    const stations = j.stops.map((s) => {
      const coords = resolveStation(s?.name);
      return {
        id: null,
        name: s?.name ?? null,
        location: coords ? { latitude: coords.lat, longitude: coords.lon } : null,
        // ONCF publishes local wall-clock HH:MM only; keep it in a "THH:MM"
        // datetime so downstream HH:MM extraction works unchanged.
        arrival: s?.arrival ? `${today}T${s.arrival}:00` : null,
        departure: s?.departure ? `${today}T${s.departure}:00` : null,
        pickup: true,
        dropoff: true,
      };
    });
    trains[name] = {
      lineName: name,
      operator: "ONCF",
      polyline: null, // filled from the route-geometry cache in run()
      stations,
      frequency:
        typeof j?.calendar === "string" ? j.calendar : (renderCalendar(j?.calendar) ?? null),
    };
  }
  return trains;
}

// ─── Official fetch strategy (finalized from the CI probe) ──────────────────

/**
 * Parse an ONCF schedule response into journeys, keeping only overnight
 * services (a departure after ~20:00 arriving the following morning).
 *
 * PROBE-GATED: implement from the captured probe artifact. The 2018-era scraper
 * (github.com/azihassan/oncf_schedule) read `//div[@class="container"]/table/tbody/tr`
 * off /fr/Horaires; the probe reports whether that structure survives, and
 * whether oncf-voyages.ma exposes a JSON API that should be used instead.
 * Returns null until then so run() fails loudly instead of publishing wrong data.
 */
export function parseScheduleHtml(_html, _corridor) {
  return null;
}

async function fetchCorridorJourneys(entry, corridor) {
  const base = entry.params?.scheduleSearchBase;
  if (!base) return null;
  const url = buildScheduleSearchUrl(base, corridor.from, corridor.to, new Date());
  if (!url) return null;
  let html = null;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "fr,en;q=0.8",
      },
    });
    if (!res.ok) {
      console.warn(`[scrape] oncf: ${corridor.id} search returned ${res.status}`);
      return null;
    }
    html = await res.text();
  } catch (err) {
    console.warn(`[scrape] oncf: ${corridor.id} fetch failed — ${err.message}`);
    return null;
  }
  return parseScheduleHtml(html, corridor);
}

export async function run(entry, ctx) {
  const journeys = [];
  for (const corridor of NIGHT_CORRIDORS) {
    const found = await fetchCorridorJourneys(entry, corridor);
    if (found?.length) journeys.push(...found);
  }
  if (!journeys.length) {
    throw new Error(
      "no official ONCF data extracted — run the ONCF probe workflow and finalize parseScheduleHtml() (see adapter header)",
    );
  }

  const overrides =
    readJsonSafe(path.join(ctx.rootDir, "data", "overrides", "station-coordinates.json")) ?? {};
  // Back-on-Track carries no Moroccan stations, so overrides do the real work here.
  const resolveStation = makeStationResolver({ botStops: ctx.shared.stops ?? {}, overrides });
  const trains = normalizeOncfTrains(journeys, { resolveStation, today: ctx.today });

  // Geometry: no official polylines exist, so use the OSM-backed builder —
  // regenerated only when a train's stop list changes (hash-gated cache).
  const scrapedDir = path.join(ctx.rootDir, "public", "data", "scraped");
  const cache = readJsonSafe(path.join(scrapedDir, GEOMETRY_CACHE_FILE))?.data ?? emptyGeometryCache();
  const pinned = entry.params?.pinnedRelations ?? {};
  for (const train of Object.values(trains)) {
    const stops = train.stations.map((s) => ({
      name: s.name,
      lat: s.location?.latitude,
      lon: s.location?.longitude,
    }));
    const resolved = await resolveRouteGeometry({
      key: `${entry.id}:${train.lineName}`,
      stops,
      pinnedRelationIds: pinned[train.lineName] ?? [],
      refCandidates: [train.lineName],
      operatorRegex: "ONCF",
      cache,
      readScrapedRelation: (id) => {
        const raw = readJsonSafe(path.join(scrapedDir, `osm-${id}.json`));
        return raw ? relationCoordsFromOverpass(raw.data, id) : null;
      },
      log: (msg) => console.log(`[scrape] oncf ${msg}`),
    });
    train.polyline = resolved.polyline;
  }

  ctx.write(GEOMETRY_CACHE_FILE, cache);
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
}
