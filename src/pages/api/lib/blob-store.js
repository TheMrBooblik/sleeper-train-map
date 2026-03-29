// lib/blob-store.js
// Wrapper around @vercel/blob for storing/retrieving datasets.
//
// Back-on-Track JSON datasets (keys: 'stops', 'view_ontd_map', 'trips'):
//   getBlobData(key) / putBlobData(key, data)
//
// OSM relation geometries (key: numeric relation ID or comma-joined IDs):
//   getOsmRelation(cacheKey) / putOsmRelation(cacheKey, data)

import { list, put } from "@vercel/blob";

const BACKONTRACK_PREFIX = "backontrack/";
const OSM_PREFIX = "osm-relation/";
const CACHE_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours

// Per-prefix module-level listing caches (avoids repeated list() calls per cold start)
const listingCaches = {};

async function getListing(prefix) {
  const now = Date.now();
  const cached = listingCaches[prefix];
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.blobs;

  const { blobs } = await list({ prefix });
  listingCaches[prefix] = { blobs, at: now };
  return blobs;
}

function invalidateListingCache(prefix) {
  delete listingCaches[prefix];
}

// ─── Back-on-Track datasets ────────────────────────────────────────────────

/**
 * Retrieve a stored Back-on-Track dataset from Vercel Blob.
 * Returns { data, uploadedAt } or null if not found / token not set.
 */
export async function getBlobData(key) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const blobs = await getListing(BACKONTRACK_PREFIX);
    const blob = blobs.find((b) => b.pathname === `${BACKONTRACK_PREFIX}${key}.json`);
    if (!blob) return null;
    const res = await fetch(blob.url);
    if (!res.ok) return null;
    return { data: await res.json(), uploadedAt: new Date(blob.uploadedAt) };
  } catch {
    return null;
  }
}

/**
 * Upload/overwrite a Back-on-Track dataset in Vercel Blob.
 */
export async function putBlobData(key, data) {
  await put(`${BACKONTRACK_PREFIX}${key}.json`, JSON.stringify(data), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
  invalidateListingCache(BACKONTRACK_PREFIX);
}

// ─── OSM relation geometries ───────────────────────────────────────────────

/**
 * Retrieve a cached OSM relation geometry from Vercel Blob.
 * cacheKey: numeric relation ID or comma-joined IDs (e.g. "18616102").
 * Returns { data, uploadedAt } or null.
 */
export async function getOsmRelation(cacheKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const blobs = await getListing(OSM_PREFIX);
    const safe = cacheKey.replace(/,/g, "_");
    const blob = blobs.find((b) => b.pathname === `${OSM_PREFIX}${safe}.json`);
    if (!blob) return null;
    const res = await fetch(blob.url);
    if (!res.ok) return null;
    return { data: await res.json(), uploadedAt: new Date(blob.uploadedAt) };
  } catch {
    return null;
  }
}

/**
 * Upload/overwrite an OSM relation geometry in Vercel Blob.
 */
export async function putOsmRelation(cacheKey, data) {
  const safe = cacheKey.replace(/,/g, "_");
  await put(`${OSM_PREFIX}${safe}.json`, JSON.stringify(data), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
  invalidateListingCache(OSM_PREFIX);
}

// ─── Shared ────────────────────────────────────────────────────────────────

/**
 * Check whether a blob dataset is fresh (uploaded within the last 25 hours).
 */
export function isFresh(uploadedAt) {
  if (!uploadedAt) return false;
  return Date.now() - new Date(uploadedAt).getTime() < CACHE_TTL_MS;
}
