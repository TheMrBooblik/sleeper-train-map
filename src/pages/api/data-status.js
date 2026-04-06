// pages/api/data-status.js
// Returns metadata about all data stored in Vercel Blob for the /data dashboard page.
// Always fresh — no CDN caching.

import {
  getBlobData,
  getNJTrains,
  getCDTrains,
  getSNCFTrains,
  getOsmRelation,
  isFresh,
} from "./lib/blob-store";

const OSM_RELATION_IDS = ["18616102"]; // European Sleeper 453

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

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(200).json({
      error: "BLOB_READ_WRITE_TOKEN not configured",
      sources: null,
    });
  }

  // Fetch all blob data in parallel
  const [stopsBlob, routesBlob, tripsBlob, njBlob, cdBlob, sncfBlob, ...osmBlobs] =
    await Promise.all([
      getBlobData("stops"),
      getBlobData("view_ontd_map"),
      getBlobData("trips"),
      getNJTrains(),
      getCDTrains(),
      getSNCFTrains(),
      ...OSM_RELATION_IDS.map((id) => getOsmRelation(id)),
    ]);

  // Back-on-Track: stops
  const stops = stopsBlob
    ? {
        uploadedAt: stopsBlob.uploadedAt,
        count: Array.isArray(stopsBlob.data) ? stopsBlob.data.length : 0,
        status: freshnessStatus(stopsBlob.uploadedAt),
        hoursAgo: hoursAgo(stopsBlob.uploadedAt),
      }
    : { uploadedAt: null, count: 0, status: "missing", hoursAgo: null };

  // Back-on-Track: routes (view_ontd_map)
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
  const routes = routesBlob
    ? {
        uploadedAt: routesBlob.uploadedAt,
        count: Array.isArray(routesBlob.data)
          ? routesBlob.data.length
          : Object.keys(routesBlob.data ?? {}).length,
        status: freshnessStatus(routesBlob.uploadedAt),
        hoursAgo: hoursAgo(routesBlob.uploadedAt),
        items: routeItems,
      }
    : { uploadedAt: null, count: 0, status: "missing", hoursAgo: null, items: [] };

  // Back-on-Track: trips
  const trips = tripsBlob
    ? {
        uploadedAt: tripsBlob.uploadedAt,
        count: Array.isArray(tripsBlob.data)
          ? tripsBlob.data.length
          : Object.keys(tripsBlob.data ?? {}).length,
        status: freshnessStatus(tripsBlob.uploadedAt),
        hoursAgo: hoursAgo(tripsBlob.uploadedAt),
      }
    : { uploadedAt: null, count: 0, status: "missing", hoursAgo: null };

  // NightJet / EuroNight (official operator data)
  let njItems = [];
  if (njBlob?.data?.trains) {
    njItems = Object.entries(njBlob.data.trains).map(([trainNumber, t]) => ({
      trainNumber,
      operator: t.operator || t.lineName || "NightJet",
      stationCount: Array.isArray(t.stations) ? t.stations.length : 0,
      origin: t.stations?.[0]?.name ?? "",
      destination: t.stations?.[t.stations?.length - 1]?.name ?? "",
    }));
    njItems.sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, undefined, { numeric: true }));
  }
  const nightjet = njBlob
    ? {
        uploadedAt: njBlob.uploadedAt,
        count: njItems.length,
        status: freshnessStatus(njBlob.uploadedAt),
        hoursAgo: hoursAgo(njBlob.uploadedAt),
        items: njItems,
      }
    : { uploadedAt: null, count: 0, status: "missing", hoursAgo: null, items: [] };

  // Czech Railways (official operator data)
  let cdItems = [];
  if (cdBlob?.data?.trains) {
    cdItems = Object.entries(cdBlob.data.trains).map(([trainNumber, t]) => ({
      trainNumber,
      stationCount: Array.isArray(t.stops) ? t.stops.length : 0,
      origin: t.stops?.[0]?.name ?? "",
      destination: t.stops?.[t.stops?.length - 1]?.name ?? "",
    }));
    cdItems.sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, undefined, { numeric: true }));
  }
  const cdRailways = cdBlob
    ? {
        uploadedAt: cdBlob.uploadedAt,
        count: cdItems.length,
        status: freshnessStatus(cdBlob.uploadedAt),
        hoursAgo: hoursAgo(cdBlob.uploadedAt),
        items: cdItems,
      }
    : { uploadedAt: null, count: 0, status: "missing", hoursAgo: null, items: [] };

  // SNCF Intercités de Nuit (official GTFS polylines)
  let sncfItems = [];
  if (sncfBlob?.data?.trains) {
    sncfItems = Object.entries(sncfBlob.data.trains).map(([trainNumber, t]) => ({
      trainNumber,
      coordinateCount: t.coordinateCount ?? 0,
    }));
    sncfItems.sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, undefined, { numeric: true }));
  }
  const sncf = sncfBlob
    ? {
        uploadedAt: sncfBlob.uploadedAt,
        count: sncfItems.length,
        status: freshnessStatus(sncfBlob.uploadedAt),
        hoursAgo: hoursAgo(sncfBlob.uploadedAt),
        items: sncfItems,
      }
    : { uploadedAt: null, count: 0, status: "missing", hoursAgo: null, items: [] };

  // OSM Relations
  const osmRelations = OSM_RELATION_IDS.map((id, i) => {
    const blob = osmBlobs[i];
    if (!blob) return { id, name: null, coordinateCount: 0, uploadedAt: null, status: "missing", hoursAgo: null };
    return {
      id,
      name: blob.data?.elements?.[0]?.tags?.name ?? blob.data?.name ?? `Relation ${id}`,
      coordinateCount: blob.data?.coordinates?.length ?? blob.data?.elements?.length ?? 0,
      uploadedAt: blob.uploadedAt,
      status: freshnessStatus(blob.uploadedAt),
      hoursAgo: hoursAgo(blob.uploadedAt),
    };
  });

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    sources: {
      nightjet,
      cdRailways,
      sncf,
      backontrack: { stops, routes, trips },
      osmRelations,
    },
  });
}
