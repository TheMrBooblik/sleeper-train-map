// pages/api/stations/geocode.js
// API endpoint for geocoding station names to coordinates
// Uses Nominatim API (OpenStreetMap geocoding service)
// Useful for finding coordinates of stations outside Germany

export default async function handler(req, res) {
  const { name } = req.query;

  if (!name) {
    return res.status(400).json({
      error: "Station name is required",
    });
  }

  try {
    // Use Nominatim API to search for railway stations
    // Rate limit: 1 request per second
    const searchQuery = `${name} railway station`;
    const url =
      `https://nominatim.openstreetmap.org/search?` +
      `q=${encodeURIComponent(searchQuery)}` +
      `&format=json` +
      `&limit=5` +
      `&addressdetails=1` +
      `&extratags=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "train-map-app/1.0",
        "Accept-Language": "en,de,fr,es,it",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Nominatim API error: ${response.status} ${response.statusText}`,
      );
    }

    const results = await response.json();

    // Filter for railway stations and extract coordinates
    const stations = results
      .filter((result) => {
        // Prefer railway stations
        return (
          result.type === "railway" ||
          result.class === "railway" ||
          result.type === "station" ||
          result.extratags?.railway === "station" ||
          result.display_name?.toLowerCase().includes("station")
        );
      })
      .map((result) => ({
        name: result.display_name || result.name || name,
        lat: parseFloat(result.lat),
        lon: parseFloat(result.lon),
        source: "nominatim",
        importance: result.importance || 0,
        type: result.type,
        class: result.class,
      }))
      .sort((a, b) => b.importance - a.importance); // Sort by importance

    // Return the best match (first result)
    if (stations.length > 0) {
      return res.status(200).json({
        station: stations[0],
        alternatives: stations.slice(1),
        count: stations.length,
      });
    }

    // If no railway station found, try to use first result anyway
    if (results.length > 0) {
      const firstResult = results[0];
      return res.status(200).json({
        station: {
          name: firstResult.display_name || firstResult.name || name,
          lat: parseFloat(firstResult.lat),
          lon: parseFloat(firstResult.lon),
          source: "nominatim",
          importance: firstResult.importance || 0,
          type: firstResult.type,
          class: firstResult.class,
        },
        alternatives: [],
        count: 1,
        note: "No railway station found, using best match",
      });
    }

    // No results found
    return res.status(404).json({
      error: "Station not found",
      query: name,
    });
  } catch (error) {
    console.error("Error geocoding station:", error);
    return res.status(500).json({
      error: "Failed to geocode station",
      details: error.message,
    });
  }
}
