// pages/api/seed-sncf.js
// On-demand endpoint: downloads the SNCF Intercités GTFS and stores polylines in Vercel Blob.
// Use this to seed SNCF data without waiting for the daily cron.
// Protected by the same CRON_SECRET as scrape-backontrack when the secret is configured.
//
// ?debug=1  — returns GTFS inspection data instead of seeding (useful for debugging 0-match issues)

import { putSNCFTrains } from "./lib/blob-store";
import { fetchSNCFNightTrainPolylines, inspectSNCFGtfs } from "./lib/sncf-fetcher";

export default async function handler(req, res) {
  const authHeader = req.headers["authorization"];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN && !req.query.debug) {
    return res.status(500).json({ error: "BLOB_READ_WRITE_TOKEN not configured" });
  }

  // Debug mode: inspect GTFS content without storing anything
  if (req.query.debug === "1") {
    try {
      const info = await inspectSNCFGtfs();
      return res.status(200).json(info);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  try {
    console.log("[seed-sncf] Fetching SNCF Intercités GTFS…");
    const trains = await fetchSNCFNightTrainPolylines();
    const count = Object.keys(trains).length;

    await putSNCFTrains({ uploadedAt: new Date().toISOString(), trains });

    console.log(`[seed-sncf] Stored ${count} SNCF IC Nuit polylines`);
    res.status(200).json({
      ok: true,
      count,
      trains: Object.fromEntries(
        Object.entries(trains).map(([k, v]) => [k, { coordinateCount: v.coordinateCount }])
      ),
    });
  } catch (err) {
    console.error("[seed-sncf] Failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}
