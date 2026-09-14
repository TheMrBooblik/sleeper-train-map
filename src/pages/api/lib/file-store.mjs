// lib/file-store.mjs
// Filesystem-backed store for scraped JSON datasets.
// Reads from public/data/scraped/ — files committed via GitHub Actions daily scrape.
// Writes are no-ops in Vercel serverless; only the scrape script writes to disk.
//
// Same exported API surface as blob-store.js so consumers only need their import updated.
//
// File envelope format: { uploadedAt: ISO8601, data: <payload> }

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "public", "data", "scraped");
const PUBLISHED_DIR = path.join(process.cwd(), "public", "data", "published");
const GTFS_DIR = path.join(process.cwd(), "public", "data", "gtfs");
const CACHE_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function readEnvelopeAtPath(fullPath) {
  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const envelope = JSON.parse(raw);
    if (!envelope?.uploadedAt) return null;
    return { data: envelope.data, uploadedAt: new Date(envelope.uploadedAt) };
  } catch {
    return null;
  }
}

function readEnvelope(name) {
  return readEnvelopeAtPath(filePath(name));
}

function writeEnvelope(name, data) {
  if (process.env.VERCEL) return; // filesystem is ephemeral in serverless
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      filePath(name),
      JSON.stringify({ uploadedAt: new Date().toISOString(), data }),
    );
  } catch (err) {
    console.warn(`[file-store] write failed for ${name}: ${err.message}`);
  }
}

// ─── Back-on-Track datasets ────────────────────────────────────────────────

export function getBlobData(key) {
  return Promise.resolve(readEnvelope(`backontrack-${key}.json`));
}

export function putBlobData(key, data) {
  writeEnvelope(`backontrack-${key}.json`, data);
  return Promise.resolve();
}

// ─── OSM relation geometries ───────────────────────────────────────────────

export function getOsmRelation(cacheKey) {
  const safe = cacheKey.replace(/,/g, "_");
  return Promise.resolve(readEnvelope(`osm-${safe}.json`));
}

export function putOsmRelation(cacheKey, data) {
  const safe = cacheKey.replace(/,/g, "_");
  writeEnvelope(`osm-${safe}.json`, data);
  return Promise.resolve();
}

// ─── Generic per-source train data ─────────────────────────────────────────

// Reads any enveloped file in public/data/scraped/ by name.
export function getScrapedFile(fileName) {
  return Promise.resolve(readEnvelope(fileName));
}

// Reads any per-source trains file declared in data/sources/registry.json
// (entry.output, e.g. "nightjet-trains.json"). The named getters below are
// kept as thin wrappers for existing callers.
export function getTrainsBySource(fileName) {
  return getScrapedFile(fileName);
}

// ─── NightJet / EuroNight train data ──────────────────────────────────────

export function getNJTrains() {
  return Promise.resolve(readEnvelope("nightjet-trains.json"));
}

export function putNJTrains(data) {
  writeEnvelope("nightjet-trains.json", data);
  return Promise.resolve();
}

// ─── Czech Railways (cd.cz) EC train timetables ───────────────────────────

export function getCDTrains() {
  return Promise.resolve(readEnvelope("cd-trains.json"));
}

export function putCDTrains(data) {
  writeEnvelope("cd-trains.json", data);
  return Promise.resolve();
}

// ─── Chinese Railways ──────────────────────────────────────────────────────

export function getChineseTrains() {
  return Promise.resolve(readEnvelope("chinese-trains.json"));
}

export function putChineseTrains(data) {
  writeEnvelope("chinese-trains.json", data);
  return Promise.resolve();
}

// ─── Italian Railways (Trenitalia ICN) ────────────────────────────────────

export function getItalianTrains() {
  return Promise.resolve(readEnvelope("italian-trains.json"));
}

export function putItalianTrains(data) {
  writeEnvelope("italian-trains.json", data);
  return Promise.resolve();
}

// ─── Caucasus Railways (Georgian Railway, ADY, South Caucasus Railway) ────

export function getCaucasusTrains() {
  return Promise.resolve(readEnvelope("caucasus-trains.json"));
}

export function putCaucasusTrains(data) {
  writeEnvelope("caucasus-trains.json", data);
  return Promise.resolve();
}

// ─── Published canonical dataset (build-time merge) ──────────────────────────

// Pre-merged { stops, viewMap, trips } payload written by
// scripts/canonicalize.mjs and committed alongside the scraped files. Served
// directly by /api/initial-data when fresh; the route falls back to merging on
// the fly when this file is missing or stale.
export function getPublishedInitialData() {
  return Promise.resolve(
    readEnvelopeAtPath(path.join(PUBLISHED_DIR, "initial-data.json")),
  );
}

// ─── GTFS bundles served as static assets ────────────────────────────────────

// Station names the browser-side GTFS merges will graft onto viewMap rows.
// The stops projection in /api/initial-data has to keep their stop records:
// attachPkpGtfsPolylinesToViewMap rebuilds via_0 from this bundle's own stop
// list, long after the payload was assembled, and expects the coordinates to
// already be on the client. Parsed once per lambda instance — the route it
// feeds is CDN-cached for an hour, so this runs about as often as a cold start.
let _gtfsStationNames = null;

export function getGtfsBundleStationNames() {
  if (_gtfsStationNames) return _gtfsStationNames;

  const names = new Set();
  try {
    const raw = fs.readFileSync(
      path.join(GTFS_DIR, "pkpTrainShapes.json"),
      "utf8",
    );
    for (const entry of Object.values(JSON.parse(raw)?.byTrainKey ?? {})) {
      for (const stop of entry?.stops ?? []) {
        if (stop?.name) names.add(stop.name);
      }
    }
  } catch {
    // Missing bundle just means a slightly larger stops list, never a failure.
  }

  _gtfsStationNames = names;
  return names;
}

// ─── Shared ────────────────────────────────────────────────────────────────

export function isFresh(uploadedAt) {
  if (!uploadedAt) return false;
  return Date.now() - new Date(uploadedAt).getTime() < CACHE_TTL_MS;
}
