// pages/api/osm-relation.js
// Fetch OpenStreetMap relation geometry (polyline) for a given relation ID

export default async function handler(req, res) {
  const { relationId } = req.query;

  if (!relationId) {
    return res.status(400).json({ error: "Missing relationId parameter" });
  }

  try {
    // Use Overpass API to fetch relation geometry
    // This query gets the full relation with all its members and their coordinates
    const overpassQuery = `
      [out:json][timeout:25];
      (
        relation(${relationId});
      );
      out geom;
    `;

    const overpassUrl = "https://overpass-api.de/api/interpreter";
    const response = await fetch(overpassUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": "train-map/1.0",
      },
      body: overpassQuery,
    });

    if (!response.ok) {
      console.error(
        `[osm-relation] Overpass API error:`,
        response.status,
        response.statusText,
      );
      return res
        .status(response.status)
        .json({ error: "Failed to fetch relation from Overpass API" });
    }

    const data = await response.json();

    if (!data.elements || data.elements.length === 0) {
      return res.status(404).json({ error: "Relation not found" });
    }

    const relation = data.elements[0];

    if (relation.type !== "relation") {
      return res.status(400).json({ error: "Element is not a relation" });
    }

    // Extract geometry from relation members
    // Relations can have ways (line segments) as members
    // We need to collect all coordinates from way members
    const coordinates = [];

    if (relation.members) {
      // Get all way members (these contain the actual geometry)
      const wayMembers = relation.members.filter(
        (member) => member.type === "way",
      );

      // Sort ways by their role/sequence if possible
      // For route relations, ways are usually ordered
      wayMembers.forEach((member) => {
        if (member.geometry && Array.isArray(member.geometry)) {
          member.geometry.forEach((point) => {
            if (point.lat && point.lon) {
              coordinates.push([point.lat, point.lon]);
            }
          });
        }
      });
    }

    // If no coordinates found in members, try to fetch ways separately
    if (coordinates.length === 0 && relation.members) {
      const wayIds = relation.members
        .filter((m) => m.type === "way")
        .map((m) => m.ref)
        .join(",");

      if (wayIds) {
        const waysQuery = `
          [out:json][timeout:25];
          (
            way(id:${wayIds});
          );
          out geom;
        `;

        const waysResponse = await fetch(overpassUrl, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "User-Agent": "train-map/1.0",
          },
          body: waysQuery,
        });

        if (waysResponse.ok) {
          const waysData = await waysResponse.json();
          if (waysData.elements) {
            waysData.elements.forEach((way) => {
              if (way.geometry && Array.isArray(way.geometry)) {
                way.geometry.forEach((point) => {
                  if (point.lat && point.lon) {
                    coordinates.push([point.lat, point.lon]);
                  }
                });
              }
            });
          }
        }
      }
    }

    // Remove duplicate consecutive coordinates
    const uniqueCoords = [];
    let lastCoord = null;
    coordinates.forEach((coord) => {
      if (
        !lastCoord ||
        lastCoord[0] !== coord[0] ||
        lastCoord[1] !== coord[1]
      ) {
        uniqueCoords.push(coord);
        lastCoord = coord;
      }
    });

    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 1 day
    res.setHeader("Content-Type", "application/json");

    return res.status(200).json({
      relationId: relation.id,
      name: relation.tags?.name || null,
      coordinates: uniqueCoords,
      count: uniqueCoords.length,
      tags: relation.tags || {},
    });
  } catch (error) {
    console.error("[osm-relation] Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
