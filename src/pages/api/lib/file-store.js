// lib/file-store.js
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
const CACHE_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function readEnvelope(name) {
  try {
    const raw = fs.readFileSync(filePath(name), "utf8");
    const envelope = JSON.parse(raw);
    if (!envelope?.uploadedAt) return null;
    return { data: envelope.data, uploadedAt: new Date(envelope.uploadedAt) };
  } catch {
    return null;
  }
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

// ─── Shared ────────────────────────────────────────────────────────────────

export function isFresh(uploadedAt) {
  if (!uploadedAt) return false;
  return Date.now() - new Date(uploadedAt).getTime() < CACHE_TTL_MS;
}
