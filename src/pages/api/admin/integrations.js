/**
 * GET /api/admin/integrations — data behind /data → Integrations.
 *
 * Answers, per operator and per route: where does this data actually come
 * from today, how fresh is it, is there an official source we could switch
 * to, and which integration is worth building next.
 *
 * Loopback-only, like every other admin surface. All the arithmetic lives in
 * src/lib/integrations/model.mjs (pure, raw-node testable); this route only
 * gathers inputs and hands back one compact payload so the tab needs a single
 * fetch.
 */
import fs from "node:fs";
import path from "node:path";
import { rejectUnlessLocalAdmin } from "../../../lib/localAdmin.mjs";
import {
  getBlobData,
  getPublishedInitialData,
  getScrapedFile,
} from "../lib/file-store.js";
import {
  buildOperatorRows,
  buildRouteRows,
  buildSourceStatus,
  blockedOperators,
  computeTotals,
  describeSource,
  nextIntegrations,
} from "../../../lib/integrations/model.mjs";
import SOURCE_REGISTRY from "../../../../data/sources/registry.json" with { type: "json" };
import OFFICIAL_SOURCES from "../../../../data/sources/official-sources.json" with { type: "json" };

// Written by scripts/canonicalize.mjs. Under public/, so a plain disk read is
// correct here — the same way data-status.js reads pkpTrainShapes.json. (Files
// under data/ must be ESM-imported instead; Next does not trace fs reads.)
function readPublishedJson(name) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "public", "data", "published", name),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

// A registry entry may declare params.statusFile instead of an output — the
// artifact it maintains on another source's behalf. Prefer the stamp inside it,
// fall back to the file's mtime.
function readStatusFileTimestamp(relPath) {
  try {
    const full = path.join(process.cwd(), relPath);
    const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    const stamp = parsed?.generatedAt ?? parsed?.uploadedAt ?? null;
    return {
      uploadedAt: stamp ?? fs.statSync(full).mtime.toISOString(),
      trainCount: Object.keys(parsed?.byTrainKey ?? {}).length || null,
    };
  } catch {
    return null;
  }
}

// The route rows carry a full station list for coverage maths; the browser
// only needs the count, and 288 × ~30 names is most of the payload.
function trimRoute({ stations, ...rest }) {
  return rest;
}

export default async function handler(req, res) {
  if (rejectUnlessLocalAdmin(req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const now = new Date();
    const published = await getPublishedInitialData();
    if (!published?.data?.viewMap) {
      return res.status(200).json({
        generatedAt: now.toISOString(),
        error:
          "No published dataset found. Run `npm run canonicalize` (it needs public/data/scraped/ to be populated by `npm run scrape`).",
        totals: null,
        operators: [],
        routes: [],
      });
    }

    // Per-source freshness: the artifact's own stamp always exists; the health
    // log adds the failure side once a nightly run has written it.
    const fileTimestamps = {};
    await Promise.all(
      SOURCE_REGISTRY.map(async (entry) => {
        const file = entry.output ?? entry.outputs?.[0] ?? null;
        if (file) {
          const blob = await getScrapedFile(file);
          if (!blob) return;
          fileTimestamps[entry.id] = {
            uploadedAt:
              blob.uploadedAt?.toISOString?.() ?? blob.uploadedAt ?? null,
            trainCount: Object.keys(blob.data?.trains ?? {}).length || null,
          };
          return;
        }
        // Sources that maintain someone else's artifact instead of a trains
        // file of their own (pkp-gtfs regenerates the GTFS bundle) still have a
        // dated output — without this they read as "never fetched" while
        // visibly feeding 16 routes.
        const statusFile = entry.params?.statusFile;
        if (!statusFile) return;
        const stamped = readStatusFileTimestamp(statusFile);
        if (stamped) fileTimestamps[entry.id] = stamped;
      }),
    );

    const healthBlob = await getScrapedFile("source-health.json");
    const health = healthBlob?.data?.sources ?? {};
    const history = readPublishedJson("route-history.json");
    const agencies = (await getBlobData("agencies"))?.data ?? {};

    const sourceStatus = buildSourceStatus({
      registry: SOURCE_REGISTRY,
      fileTimestamps,
      health,
      now,
    });
    const routeRows = buildRouteRows({
      viewMap: published.data.viewMap,
      registry: SOURCE_REGISTRY,
      history: history?.routes ?? {},
      sourceHealth: sourceStatus,
      now,
    });
    const operators = buildOperatorRows({
      routeRows,
      registry: SOURCE_REGISTRY,
      catalog: OFFICIAL_SOURCES,
      agencies,
      sourceStatus,
      now,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      generatedAt: now.toISOString(),
      dataGeneratedAt: published.uploadedAt?.toISOString?.() ?? null,
      historyGeneratedAt: history?.generatedAt ?? null,
      healthGeneratedAt: healthBlob?.data?.runFinishedAt ?? null,
      totals: computeTotals(routeRows, operators),
      next: nextIntegrations(operators).map((o) => o.id),
      blocked: blockedOperators(operators).map((o) => o.id),
      operators,
      routes: routeRows.map(trimRoute),
      sources: Object.fromEntries(
        SOURCE_REGISTRY.map((entry) => [
          entry.id,
          { ...describeSource(entry), ...sourceStatus[entry.id] },
        ]),
      ),
    });
  } catch (err) {
    console.error("[integrations] failed:", err);
    return res.status(500).json({ error: err.message });
  }
}
