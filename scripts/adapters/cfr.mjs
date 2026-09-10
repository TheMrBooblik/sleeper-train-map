// scripts/adapters/cfr.mjs
// CFR Călători (Romania) from the official open-data timetable on data.gov.ro.
//
// Flow, nightly:
//   1. CKAN package_show (params.baseUrl) → pick the current timetable-year
//      resource (the resource UUID changes every December, so it is resolved
//      from the dataset page rather than pinned) — lib: pickTimetableResource.
//      If that is unreachable and params.localTimetable names a committed copy,
//      it is used instead and the reason is recorded in ctx.errors, so the run
//      keeps its data without pretending the official endpoint answered.
//   2. Download the XML (or a zip of it) into gtfs-data/cfr/, decode per its
//      declared encoding (gzip is unwrapped by bytes, so the committed copy can
//      be compressed), parse only the train numbers the map needs.
//   3. Rebuild each Back-on-Track CFR row's stop list from the official
//      segments, keyed by BoT's own trip label ("IRN 1669") so the registry's
//      trainsByNumber enrichment finds it: full stop list, official times,
//      canonical (diacritic) BoT spellings so every stop is a map dot on the
//      line. International trains get the Romanian stretch spliced into BoT's
//      chain (`coverage: "partial"`) — the XML stops at the border.
//   4. Geometry from the OSM-backed route-geometry cache (hash-gated on the
//      stop list; Overpass discovery by train ref, validated against every
//      intermediate stop; straight chain through the official stops as the
//      floor — already far better than BoT's 2–3 via points).
//
// Never fatal for the map: any failure throws, the runner records it in
// source-health.json and the sticky merge keeps yesterday's file for the
// enrichment. A parse that yields nothing logs the file's tag/attribute
// census, so the nightly log is the probe when a year's file changes shape.
// The dev sandbox has no egress to data.gov.ro; dispatch "Probe CFR source"
// (scripts/probe-cfr.mjs) to see the live file from CI.
//
// Debug / CI reuse: CFR_XML_PATH=/path/to/file.xml skips the download and wins
// over both the remote and the committed copy.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { downloadFile } from "../lib/gtfs.mjs";
import { describeError } from "../lib/describe-error.mjs";
import {
  emptyGeometryCache,
  resolveRouteGeometry,
} from "../lib/route-geometry.mjs";
import { relationCoordsFromOverpass } from "../../src/pages/api/lib/osm-geo.mjs";
import {
  buildCfrTrains,
  decodeXmlBytes,
  describeParseStats,
  makeCfrStationIndex,
  parseMersTrenXml,
  pickTimetableResource,
  rowInAgency,
  trainNumbersFromLabel,
} from "../lib/cfr-mers-tren.mjs";

const GEOMETRY_CACHE_FILE = "route-geometry.json";
const CKAN_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Numbers the parser has to keep: every CFR row's labels plus the allowlist extras. */
export function wantedTrainNumbers(viewMap, extraTrains, agencyPattern) {
  const numbers = new Set();
  for (const route of Object.values(viewMap ?? {})) {
    if (!rowInAgency(route, agencyPattern)) continue;
    for (const d of [0, 1]) {
      trainNumbersFromLabel(route[`trip_short_name_${d}`]).forEach((n) =>
        numbers.add(n),
      );
    }
  }
  for (const extra of extraTrains ?? []) {
    (extra?.numbers?.length
      ? extra.numbers
      : trainNumbersFromLabel(extra?.label)
    ).forEach((n) => numbers.add(String(n)));
  }
  return numbers;
}

/** Spellings BoT rows already use — the index prefers these among duplicates. */
function rowStationNames(viewMap, agencyPattern) {
  const names = new Set();
  for (const route of Object.values(viewMap ?? {})) {
    if (!rowInAgency(route, agencyPattern)) continue;
    for (const d of [0, 1]) {
      [route[`origin_trip_${d}`], route[`destination_trip_${d}`]]
        .filter(Boolean)
        .forEach((n) => names.add(n));
      String(route[`via_${d}`] ?? "")
        .split(" - ")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((n) => names.add(n));
    }
  }
  return [...names];
}

async function fetchJson(url, log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CKAN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Download the resource and return the path of the XML to parse. */
async function fetchTimetableXml(resource, workDir, log) {
  fs.mkdirSync(workDir, { recursive: true });
  const isZip = resource.format === "ZIP" || /\.zip(\?|$)/i.test(resource.url);
  const target = path.join(workDir, isZip ? "mers-tren.zip" : "mers-tren.xml");
  log(`downloading ${resource.url}`);
  await downloadFile(resource.url, target);
  if (!isZip) return target;
  const unpacked = path.join(workDir, "unpacked");
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });
  execSync(`unzip -o -q "${target}" -d "${unpacked}"`, { stdio: "inherit" });
  const xmls = fs
    .readdirSync(unpacked, { recursive: true })
    .map(String)
    .filter((f) => f.toLowerCase().endsWith(".xml"))
    .map((f) => path.join(unpacked, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  if (!xmls.length) throw new Error("zip contained no .xml file");
  return xmls[0];
}

/**
 * Where tonight's timetable comes from: the live CKAN resource if it can be
 * reached, else the committed copy.
 *
 * Remote first, so a network that can reach data.gov.ro gets the live file.
 * GitHub's runners cannot: the connection is dropped rather than refused, and
 * every nightly run since this source went live has died on the same ~10.5s
 * connect timeout. The national timetable changes once a year (the second
 * Sunday in December), so a committed copy is not a stale cache — it is the
 * same file the CKAN resource serves, fetched from a network that can see it,
 * and refreshed on the same annual cadence.
 *
 * Falling back still counts as a failure worth reporting: without the push to
 * ctx.errors the run would read as a clean success and hide that the official
 * endpoint is unreachable — exactly the "a fresh fetch is not fresh data"
 * blindness the source-health log exists to prevent.
 *
 * I/O is injected so the ordering can be tested without a network or a parse.
 *
 * @returns {Promise<{xmlPath: string, resource: object|null, origin: string}>}
 */
export async function resolveTimetableSource({
  entry,
  ctx,
  baseUrl,
  localTimetable,
  workDir,
  log = () => {},
  fetchPackage = (url) => fetchJson(url, log),
  downloadTimetable = (res, dir) => fetchTimetableXml(res, dir, log),
  exists = (p) => fs.existsSync(p),
  env = process.env,
}) {
  // The debug override wins over both, so a local file can be forced.
  if (env.CFR_XML_PATH) {
    return {
      xmlPath: path.resolve(ctx.rootDir, env.CFR_XML_PATH),
      resource: null,
      origin: `CFR_XML_PATH=${env.CFR_XML_PATH}`,
    };
  }
  const localPath = localTimetable
    ? path.join(ctx.rootDir, localTimetable)
    : null;
  try {
    log(`resolving current timetable resource via ${baseUrl}`);
    const pkg = await fetchPackage(baseUrl);
    const resource = pickTimetableResource(pkg);
    if (!resource) {
      const names = (pkg?.result?.resources ?? [])
        .map((r) => `${r?.name} [${r?.format}]`)
        .join("; ");
      throw new Error(
        `no XML/ZIP timetable resource in package_show (resources: ${names || "none"})`,
      );
    }
    log(
      `resource: ${resource.name} [${resource.format}] modified ${resource.lastModified ?? "?"}`,
    );
    const xmlPath = await downloadTimetable(resource, workDir);
    log(`timetable source: ${resource.url}`);
    return { xmlPath, resource, origin: resource.url };
  } catch (err) {
    if (!localPath || !exists(localPath)) throw err;
    const reason = describeError(err);
    log(
      `remote timetable unavailable (${reason}) — falling back to ${localTimetable}`,
    );
    ctx.errors?.push({
      source: entry.id,
      error: `remote timetable unavailable, used committed ${localTimetable}: ${reason}`,
    });
    log(`timetable source: ${localTimetable}`);
    return { xmlPath: localPath, resource: null, origin: localTimetable };
  }
}

export async function run(entry, ctx) {
  const {
    baseUrl,
    configPath,
    agencyPattern = "CFR",
    localTimetable = null,
  } = entry.params ?? {};
  if (!baseUrl || !configPath) {
    throw new Error(
      `${entry.id}: params.baseUrl and params.configPath are required`,
    );
  }
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = readJsonSafe(path.join(ctx.rootDir, configPath)) ?? {};
  const extraTrains = Array.isArray(config.trains) ? config.trains : [];
  const viewMap = ctx.shared.viewMap ?? {};
  const scrapedDir = path.join(ctx.rootDir, "public", "data", "scraped");
  const workDir = path.join(ctx.rootDir, "gtfs-data", `${entry.id}-unpacked`);

  // 1–2. Resolve + download, with a committed copy as the fallback.
  const { xmlPath, resource, origin } = await resolveTimetableSource({
    entry,
    ctx,
    baseUrl,
    localTimetable,
    workDir,
    log,
  });

  // 3. Parse only what the map needs.
  const wanted = wantedTrainNumbers(viewMap, extraTrains, agencyPattern);
  const xml = decodeXmlBytes(fs.readFileSync(xmlPath));
  const { trains: xmlTrains, stats } = parseMersTrenXml(xml, {
    onlyNumbers: wanted,
  });
  log(
    `parsed: ${describeParseStats(stats)}; wanted ${wanted.size} number(s), found ${xmlTrains.size}`,
  );
  if (stats.trains === 0) {
    throw new Error(
      `${entry.id}: no <Tren> elements found — file shape changed? ${describeParseStats(stats)}`,
    );
  }

  const overrides =
    readJsonSafe(
      path.join(ctx.rootDir, "data", "overrides", "station-coordinates.json"),
    ) ?? {};
  const resolveStation = makeCfrStationIndex({
    botStops: ctx.shared.stops ?? {},
    preferred: rowStationNames(viewMap, agencyPattern),
    overrides,
    catalog: config.stations ?? {},
  });
  const { trains, report } = buildCfrTrains({
    xmlTrains,
    viewMap,
    resolveStation,
    today: ctx.today,
    agencyPattern,
    agencyId: entry.agencyDefaults?.agencyId ?? "CFR",
    operatorName: entry.agencyDefaults?.operatorName ?? "CFR Călători",
    extraTrains,
  });
  log(
    `matched ${report.matched.length} full + ${report.partial.length} partial train(s); unmatched: ${
      report.unmatched.join(", ") || "none"
    }${report.skippedShort.length ? `; too short: ${report.skippedShort.join(", ")}` : ""}`,
  );
  if (report.unknownStations.length) {
    log(
      `${report.unknownStations.length} official stop name(s) without a known station (no map dot): ${report.unknownStations.slice(0, 20).join(", ")}${report.unknownStations.length > 20 ? ", …" : ""}`,
    );
  }

  // Freshness safety net (mirrors gtfs-sleeper / europeansleeper): the file
  // parsed but none of our trains matched → naming or shape drifted. Fail
  // loudly so the sticky merge keeps yesterday's trains instead of publishing
  // an empty operator.
  if (Object.keys(trains).length === 0 && xmlTrains.size > 0) {
    throw new Error(
      `${entry.id}: ${xmlTrains.size} wanted train(s) parsed but none matched a row's endpoints — unmatched: ${report.unmatched.join(", ")}`,
    );
  }
  if (Object.keys(trains).length === 0) {
    throw new Error(
      `${entry.id}: none of the ${wanted.size} wanted train number(s) exist in the file — ${describeParseStats(stats)}`,
    );
  }

  // 4. Geometry, cached by stop-list hash in the shared route-geometry file.
  const cache =
    readJsonSafe(path.join(scrapedDir, GEOMETRY_CACHE_FILE))?.data ??
    emptyGeometryCache();
  for (const train of Object.values(trains)) {
    const stops = train.stations.map((s) => ({
      name: s.name,
      lat: s.location?.latitude,
      lon: s.location?.longitude,
    }));
    const refs = [
      ...new Set(
        train.officialNumbers.flatMap((n) => [
          n,
          `IR ${n}`,
          `IRN ${n}`,
          `IC ${n}`,
          `R ${n}`,
        ]),
      ),
    ];
    const resolved = await resolveRouteGeometry({
      key: `${entry.id}:${train.lineName}`,
      stops,
      refCandidates: refs,
      operatorRegex: null,
      cache,
      allowChain: true,
      readScrapedRelation: (id) => {
        const raw = readJsonSafe(path.join(scrapedDir, `osm-${id}.json`));
        return raw ? relationCoordsFromOverpass(raw.data, id) : null;
      },
      log: (msg) => log(`route-geometry ${msg}`),
    });
    train.polyline = resolved.polyline;
    train.geometryMethod = resolved.method;
  }
  ctx.write(GEOMETRY_CACHE_FILE, cache);

  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    // Provenance, because `resource` is null whenever the committed copy was
    // used and the file would otherwise not say which of the two it describes.
    origin,
    resource: resource
      ? {
          name: resource.name,
          url: resource.url,
          lastModified: resource.lastModified,
        }
      : null,
    trains,
  });
  log(`stored ${Object.keys(trains).length} train(s)`);
}
