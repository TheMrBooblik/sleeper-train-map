// pages/api/cd-trains.js
// Serves Czech Railways (cd.cz) EC train timetable data from Vercel Blob.
// Data is scraped daily by scrape-backontrack.js.

import { getCDTrains, isFresh } from "./lib/blob-store";

export default async function handler(req, res) {
  try {
    const blob = await getCDTrains();
    if (!blob || !isFresh(blob.uploadedAt)) {
      return res.status(404).json({ error: "CD train data not available" });
    }
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.status(200).json(blob.data);
  } catch (err) {
    console.error("[cd-trains] Error:", err);
    res.status(500).json({ error: "Failed to load CD train data" });
  }
}
