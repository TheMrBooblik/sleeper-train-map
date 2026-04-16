// pages/api/nightjet-trains.js
// Exposes the NightJet / EuroNight train timetable data stored in Vercel Blob.
//
// The scrape cron (`pages/api/scrape-backontrack.js`) stores this daily under
// `nightjet/trains.json` as { uploadedAt, trains: { "NJ 403": { stations, polyline, ... }, ... } }.
//
// The frontend uses this endpoint as a fallback when Back-on-Track trips.json
// has no trip rows for an NJ/EN route selection.

import { getNJTrains, isFresh } from "./lib/blob-store";

export default async function handler(_req, res) {
  try {
    const blob = await getNJTrains();

    // When Blob isn't configured or data isn't available yet, return an empty payload.
    if (!blob?.data?.trains) {
      res.setHeader(
        "Cache-Control",
        // Cache for a short time, but allow stale while revalidating.
        "public, s-maxage=300, stale-while-revalidate=3600",
      );
      return res.status(200).json({ uploadedAt: null, trains: {} });
    }

    // Cached for 1 hour when fresh; shorter when stale.
    res.setHeader(
      "Cache-Control",
      isFresh(blob.uploadedAt)
        ? "public, s-maxage=3600, stale-while-revalidate=86400"
        : "public, s-maxage=300, stale-while-revalidate=3600",
    );
    res.setHeader("Content-Type", "application/json");

    return res.status(200).json(blob.data);
  } catch (error) {
    console.error("[nightjet-trains] Error:", error);
    return res.status(500).json({ error: "Failed to load NightJet trains" });
  }
}

