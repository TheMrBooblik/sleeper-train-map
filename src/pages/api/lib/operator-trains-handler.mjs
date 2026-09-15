// lib/operator-trains-handler.mjs
// Shared handler for serving a per-source scraped trains file
// ({ uploadedAt, trains } envelope under public/data/scraped/).
//
// missing: "empty" → 200 with { uploadedAt: null, trains: {} } when absent
//          "404"   → 404 when absent or stale (legacy cd-trains behaviour)

import { getTrainsBySource, isFresh } from "./file-store.mjs";

export function createTrainsFileHandler({ file, label, missing = "empty" }) {
  return async function handler(_req, res) {
    try {
      const blob = await getTrainsBySource(file);

      if (missing === "404") {
        if (!blob || !isFresh(blob.uploadedAt)) {
          return res.status(404).json({ error: `${label} data not available` });
        }
      } else if (!blob?.data?.trains) {
        res.setHeader(
          "Cache-Control",
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
      console.error(`[${label}] Error:`, error);
      return res.status(500).json({ error: `Failed to load ${label} data` });
    }
  };
}
