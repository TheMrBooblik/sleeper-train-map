// pages/api/italian-trains.js
// Serves Italian ICN train station data from the static scraped file.

import { getItalianTrains, isFresh } from "./lib/file-store";

export default async function handler(_req, res) {
  try {
    const blob = await getItalianTrains();

    if (!blob?.data?.trains) {
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
      return res.status(200).json({ uploadedAt: null, trains: {} });
    }

    res.setHeader(
      "Cache-Control",
      isFresh(blob.uploadedAt)
        ? "public, s-maxage=3600, stale-while-revalidate=86400"
        : "public, s-maxage=300, stale-while-revalidate=3600",
    );
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(blob.data);
  } catch (error) {
    console.error("[italian-trains] Error:", error);
    return res.status(500).json({ error: "Failed to load Italian ICN trains" });
  }
}
