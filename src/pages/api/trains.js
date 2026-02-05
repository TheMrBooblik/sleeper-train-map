// pages/api/trains.js
import { enrichStopsData, enrichRoutesData } from "../../lib/uzDataEnricher";

export default async function handler(req, res) {
  const { type } = req.query;

  const url = `https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/${type}.json`;

  try {
    const response = await fetch(url, {
      headers: {
        "Accept-Encoding": "gzip, deflate, br",
      },
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch ${type}:`,
        response.status,
        response.statusText,
      );
      throw new Error(
        `Failed to fetch data: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type");
    if (
      !contentType ||
      (!contentType.includes("application/json") &&
        !contentType.includes("text/plain"))
    ) {
      console.error(`Invalid content type for ${type}:`, contentType);
      throw new Error(`Invalid content type: ${contentType}`);
    }

    let jsonData = await response.json();

    // Enrich with manual UZ data if available
    try {
      console.log('[API] Request type:', type);
      if (type === "stops") {
        console.log('[API] Enriching stops data');
        jsonData = await enrichStopsData(jsonData);
      } else if (type === "view_ontd_map") {
        console.log('[API] Enriching view_ontd_map data');
        const before = jsonData['180']?.via_0;
        jsonData = await enrichRoutesData(jsonData);
        const after = jsonData['180']?.via_0;
        console.log('[API] Route 180 via_0 BEFORE enrichment:', before);
        console.log('[API] Route 180 via_0 AFTER enrichment:', after);
      }
    } catch (enrichError) {
      console.error('[API] Error enriching data:', enrichError);
      // Continue with non-enriched data
    }

    // Disable caching during development to ensure fresh data
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Content-Type", "application/json");

    res.status(200).json(jsonData);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Error fetching data" });
  }
}
