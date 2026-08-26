// pages/api/data-status.js
// Returns freshness metadata for the /data dashboard, derived from the source
// registry (data/sources/registry.json) — every registered source appears
// automatically; adding an operator needs no change here. Loopback-only, same
// gate as /data itself.
//
// Response shape (uniform, rendered generically by the Data Sources tab):
// { generatedAt, sources: [{ id, label, description, official, enabled,
//   datasets: [{ label, count, status, hoursAgo, uploadedAt, items?, itemLabel? }] }] }

import fs from "node:fs";
import path from "node:path";
import { getBlobData, getOsmRelation, getTrainsBySource } from "./lib/file-store";
import SOURCE_REGISTRY from "../../../data/sources/registry.json" with { type: "json" };
import { rejectUnlessLocalAdmin } from "../../lib/localAdmin.mjs";

function hoursAgo(date) {
  if (!date) return null;
  return Math.round((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60));
}

function freshnessStatus(uploadedAt) {
  if (!uploadedAt) return "missing";
  const hours = hoursAgo(uploadedAt);
  if (hours <= 25) return "fresh";
  if (hours <= 50) return "stale";
  return "old";
}

function dataset(label, uploadedAt, count, extra = {}) {
  return {
    label,
    uploadedAt: uploadedAt ?? null,
    count,
    status: freshnessStatus(uploadedAt),
    hoursAgo: hoursAgo(uploadedAt),
    ...extra,
  };
}

const MISSING = { uploadedAt: null, count: 0, status: "missing", hoursAgo: null };

// ─── Per-kind dataset builders ────────────────────────────────────────────────

async function backontrackDatasets() {
  const [stopsBlob, routesBlob, tripsBlob, agenciesBlob] = await Promise.all([
    getBlobData("stops"),
    getBlobData("view_ontd_map"),
    getBlobData("trips"),
    getBlobData("agencies"),
  ]);

  const countOf = (blob) =>
    Array.isArray(blob?.data)
      ? blob.data.length
      : Object.keys(blob?.data ?? {}).length;

  let routeItems = [];
  if (routesBlob?.data) {
    const entries = Array.isArray(routesBlob.data)
      ? routesBlob.data
      : Object.values(routesBlob.data);
    routeItems = entries.slice(0, 300).map((r) => ({
      id: r.route_id ?? r.id,
      name: r.trip_short_name_0 || r.trip_short_name || "",
      origin: r.origin_trip_0 || r.origin || "",
      destination: r.destination_trip_0 || r.destination || "",
      isActive: r.is_active !== "N",
    }));
  }

  return [
    stopsBlob
      ? dataset("Stops", stopsBlob.uploadedAt, countOf(stopsBlob))
      : { label: "Stops", ...MISSING },
    routesBlob
      ? dataset("Routes", routesBlob.uploadedAt, countOf(routesBlob), {
          items: routeItems,
          itemLabel: "routes",
        })
      : { label: "Routes", ...MISSING, items: [] },
    tripsBlob
      ? dataset("Trips", tripsBlob.uploadedAt, countOf(tripsBlob))
      : { label: "Trips", ...MISSING },
    agenciesBlob
      ? dataset("Agencies", agenciesBlob.uploadedAt, countOf(agenciesBlob))
      : { label: "Agencies", ...MISSING },
  ];
}

async function trainsFileDatasets(entry) {
  const blob = await getTrainsBySource(entry.output);
  if (!blob?.data?.trains) return [{ label: "Trains", ...MISSING, items: [] }];

  const items = Object.entries(blob.data.trains).map(([trainNumber, t]) => {
    const stopsArr = t.stations || t.stops || [];
    return {
      trainNumber,
      operator:
        t.operator || t.lineName || entry.agencyDefaults?.operatorName || "",
      stationCount: Array.isArray(stopsArr) ? stopsArr.length : 0,
      origin: stopsArr?.[0]?.name ?? "",
      destination: stopsArr?.[stopsArr.length - 1]?.name ?? "",
    };
  });
  items.sort((a, b) =>
    a.trainNumber.localeCompare(b.trainNumber, undefined, { numeric: true }),
  );

  return [
    dataset("Trains", blob.uploadedAt, items.length, {
      items,
      itemLabel: "trains",
    }),
  ];
}

async function osmDatasets(entry) {
  const relationIds = entry.params?.relationIds ?? [];
  const blobs = await Promise.all(relationIds.map((id) => getOsmRelation(id)));
  return relationIds.map((id, i) => {
    const blob = blobs[i];
    if (!blob) return { label: `Relation ${id}`, ...MISSING };
    const name =
      blob.data?.elements?.[0]?.tags?.name ?? blob.data?.name ?? `Relation ${id}`;
    const count =
      blob.data?.coordinates?.length ?? blob.data?.elements?.length ?? 0;
    return dataset(name, blob.uploadedAt, count);
  });
}

// PKP / Polish rail map shapes: committed JSON from `npm run parse-pkp-gtfs`.
function statusFileDatasets(entry) {
  const filePath = path.join(process.cwd(), ...entry.params.statusFile.split("/"));
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    const byTrainKey = data.byTrainKey || {};
    const keys = Object.keys(byTrainKey).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const items = keys.map((k) => ({
      trainNumber: k,
      coordinateCount: byTrainKey[k]?.positions?.length ?? 0,
    }));
    return [
      dataset("Train keys (map polylines)", data.generatedAt || null, keys.length, {
        items,
        itemLabel: "trains",
        sourceUrl: data.source || null,
      }),
    ];
  } catch {
    return [{ label: "Train keys (map polylines)", ...MISSING, items: [] }];
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (rejectUnlessLocalAdmin(req, res)) return;
  const sources = await Promise.all(
    SOURCE_REGISTRY.map(async (entry) => {
      let datasets = [];
      try {
        if (entry.kind === "backontrack") datasets = await backontrackDatasets();
        else if (entry.kind === "osm") datasets = await osmDatasets(entry);
        else if (entry.output) datasets = await trainsFileDatasets(entry);
        else if (entry.params?.statusFile) datasets = statusFileDatasets(entry);
        else return null; // nothing to report (e.g. manual GTFS artifacts)
      } catch (err) {
        console.error(`[data-status] ${entry.id} failed:`, err);
        datasets = [{ label: "Error", ...MISSING }];
      }
      return {
        id: entry.id,
        label: entry.label,
        description: entry.description ?? null,
        official: !!entry.official,
        enabled: !!entry.enabled,
        datasets,
      };
    }),
  );

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    sources: sources.filter(Boolean),
  });
}
