// scripts/adapters/backontrack.mjs
// Back-on-Track community dataset: stops, view_ontd_map, trips, agencies (raw JSON on GitHub).
// Writes stops + trips + agencies immediately; view_ontd_map is held on ctx.shared so the
// runner can merge NightJet polylines + synthetic standalone routes into it
// before writing (post-step in scrape-data.mjs).

import fs from "node:fs";
import path from "node:path";

// The upstream files are exported from a Google Sheet; when that export crashes
// it commits an HTML error page (served with HTTP 200) in place of the JSON, so
// res.ok is not enough — we must verify the body parses. A single bad file must
// not sink the whole critical scrape: fall back to the last-good committed copy
// in public/data/scraped/ (same resilience as the sticky-trains merge) and keep
// going, surfacing a warning. Only a missing/unparseable fallback is fatal.
async function fetchBackontrack(baseUrl, type, ctx) {
  const filename = `backontrack-${type}.json`;
  let parseError = null;
  try {
    const res = await fetch(`${baseUrl}/${type}.json`, {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    if (!res.ok) throw new Error(`Failed to fetch ${type}: ${res.status}`);
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Unexpected non-object payload for ${type}`);
    }
    return parsed;
  } catch (err) {
    parseError = err;
  }

  // Reuse the last-good committed copy (committed format: { uploadedAt, data }).
  try {
    const previous = JSON.parse(
      fs.readFileSync(
        path.join(ctx.rootDir, "public", "data", "scraped", filename),
        "utf8",
      ),
    );
    if (previous?.data && typeof previous.data === "object") {
      console.warn(
        `[backontrack] WARN: ${type}.json was not valid JSON (upstream error page) — reusing last-good committed copy: ${parseError.message}`,
      );
      ctx.errors?.push({ source: "backontrack", error: parseError.message });
      return previous.data;
    }
  } catch {
    // fall through to rethrow below
  }

  // No usable fallback — a genuine, unrecoverable failure.
  throw parseError;
}

export async function run(entry, ctx) {
  const baseUrl = entry.params?.baseUrl;
  const [stops, view_ontd_map, trips, agencies] = await Promise.all([
    fetchBackontrack(baseUrl, "stops", ctx),
    fetchBackontrack(baseUrl, "view_ontd_map", ctx),
    fetchBackontrack(baseUrl, "trips", ctx),
    fetchBackontrack(baseUrl, "agencies", ctx),
  ]);
  ctx.write("backontrack-stops.json", stops);
  ctx.write("backontrack-trips.json", trips);
  ctx.write("backontrack-agencies.json", agencies);
  ctx.shared.viewMap = view_ontd_map;
  ctx.shared.trips = trips;
  ctx.shared.stops = stops; // station-name → coords lookups in later adapters
}
