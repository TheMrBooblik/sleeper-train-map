#!/usr/bin/env node
/**
 * Regenerate data/seo/redirects.json — the old-URL → new-URL map consumed by
 * next.config.js.
 *
 * Run: npm run build-redirects   (also runs nightly inside the scrape workflow)
 *
 * THE FILE IS APPEND-ONLY. A nightly scrape can drop a route or rename a station,
 * but the URL Google indexed last month still has to resolve. Entries are merged
 * in and never deleted; removing one is a deliberate human act.
 *
 * What it emits:
 *   /trains/<train-slug>  →  /connections/<pair-slug>
 *     The per-train pages were retired into their city-pair parent. Slugs are
 *     computed with the same shared .mjs helpers the Next build uses, so a
 *     redirect can never point at a URL the build doesn't emit.
 *
 * Historical entries seeded by hand (old directed /connections/ slugs from before
 * pairs became undirected, and the /trains index) already live in the JSON and are
 * preserved untouched by the merge.
 */

import fs from "node:fs";
import path from "node:path";

import { buildPairSlug } from "../src/lib/seo/slugify.mjs";
import { buildRouteSlugMaps, routeEndpoints } from "../src/lib/seo/routeSlugs.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLISHED = path.join(ROOT, "public/data/published/initial-data.json");
const OUT = path.join(ROOT, "data/seo/redirects.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** The connection page a viewMap row belongs to, or "" if it has no usable endpoints. */
export function pairSlugForRoute(route) {
  for (const dir of [0, 1]) {
    const o = route[`origin_trip_${dir}`];
    const d = route[`destination_trip_${dir}`];
    if (!o || !d) continue;
    const a = cityForStation(o);
    const b = cityForStation(d);
    if (!a || !b || a === b) continue;
    const slug = buildPairSlug(a, b);
    if (slug) return slug;
  }
  // Fall back to the primary endpoints (covers rows that only publish one leg).
  const { origin, destination } = routeEndpoints(route);
  const a = cityForStation(origin);
  const b = cityForStation(destination);
  if (a && b && a !== b) return buildPairSlug(a, b);
  return "";
}

/** { oldPath: newPath } for every retired per-train URL in the current payload. */
export function buildTrainRedirects(viewMap) {
  const { byRouteId } = buildRouteSlugMaps(viewMap);
  const out = {};
  const orphans = [];
  for (const route of Object.values(viewMap)) {
    const routeId = String(route.route_id);
    const trainSlug = byRouteId.get(routeId);
    if (!trainSlug) continue;
    const pair = pairSlugForRoute(route);
    if (!pair) {
      orphans.push(trainSlug);
      continue;
    }
    out[`/trains/${trainSlug}`] = `/connections/${pair}`;
  }
  return { redirects: out, orphans };
}

/**
 * Collapse any chain so every source lands on its final destination in one hop.
 * Chains waste crawl budget, and crawl budget is the whole problem this migration
 * is solving. Cycles are broken and reported rather than looped on.
 */
export function flattenRedirects(map) {
  const out = {};
  const cycles = [];
  for (const src of Object.keys(map)) {
    let dest = map[src];
    const seen = new Set([src]);
    while (map[dest] !== undefined) {
      if (seen.has(dest)) {
        cycles.push(src);
        break;
      }
      seen.add(dest);
      dest = map[dest];
    }
    out[src] = dest;
  }
  return { flattened: out, cycles };
}

function main() {
  const published = readJson(PUBLISHED, null);
  if (!published?.data?.viewMap) {
    console.error(`[redirects] cannot read ${PUBLISHED} — nothing to do`);
    process.exit(1);
  }

  const existing = readJson(OUT, {});
  const { redirects: fresh, orphans } = buildTrainRedirects(published.data.viewMap);

  // Merge: fresh values win for keys they cover (a route's pair can legitimately
  // change when a station is renamed), everything historical is preserved.
  const merged = { ...existing, ...fresh };
  const { flattened, cycles } = flattenRedirects(merged);

  const sorted = {};
  for (const k of Object.keys(flattened).sort()) sorted[k] = flattened[k];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");

  const added = Object.keys(fresh).filter((k) => existing[k] === undefined).length;
  const kept = Object.keys(existing).filter((k) => fresh[k] === undefined).length;
  console.log(
    `[redirects] ${Object.keys(sorted).length} total (${added} new, ${kept} historical kept)`,
  );
  if (orphans.length) {
    console.warn(
      `[redirects] ${orphans.length} route(s) have no connection page: ${orphans.join(", ")}`,
    );
  }
  if (cycles.length) {
    console.warn(`[redirects] broke ${cycles.length} cycle(s): ${cycles.join(", ")}`);
  }
}

if (import.meta.filename === process.argv[1]) main();
