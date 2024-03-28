export default async function handler(req, res) {
    const overpassUrl = "https://overpass-api.de/api/interpreter";
    const query = `
    [out:json];
    node["railway"="station"](50.0, 3.0, 52.0, 6.0);
    out body;
  `;

    try {
        const response = await fetch(overpassUrl, {
            method: "POST",
            body: query,
        });

        const data = await response.json();
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
}
