// pages/api/trains.js
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

    const jsonData = await response.json();

    // Set caching headers to reduce repeated requests
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    res.setHeader("Content-Type", "application/json");

    res.status(200).json(jsonData);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Error fetching data" });
  }
}
