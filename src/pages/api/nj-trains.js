// pages/api/nj-trains.js
// Serves NightJet / EuroNight train timetable data from Vercel Blob.
// Data is scraped daily by scrape-backontrack.js.
// Returns { uploadedAt, trains: { "NJ 403": { lineName, operator, polyline, stations: [...] }, ... } }

import { getNJTrains, isFresh } from "./lib/blob-store";

export default async function handler(req, res) {
  try {
    const blob = await getNJTrains();
    if (!blob || !isFresh(blob.uploadedAt)) {
      return res.status(404).json({ error: "NJ train data not available" });
    }
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.status(200).json(blob.data);
  } catch (err) {
    console.error("[nj-trains] Error:", err);
    res.status(500).json({ error: "Failed to load NJ train data" });
  }
}
