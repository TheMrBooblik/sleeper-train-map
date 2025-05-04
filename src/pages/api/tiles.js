export default async function handler(req, res) {
  const { z, x, y, provider = 'osm' } = req.query;

  let tileUrl;
  switch (provider) {
    case 'thunderforest':
      const tfApiKey = process.env.THUNDER_FOREST;
      tileUrl = `https://tile.thunderforest.com/transport/${z}/${x}/${y}.png?apikey=${tfApiKey}`;
      break;
    case 'osm':
    default:
      tileUrl = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
      break;
  }

  try {
    const response = await fetch(tileUrl);
    if (!response.ok) throw new Error("Tile fetch failed");

    const buffer = await response.arrayBuffer();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).send("Error fetching tile");
  }
}