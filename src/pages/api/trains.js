// pages/api/trains.js
export default async function handler(req, res) {
    const { type } = req.query;

    const url = `https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/${type}.json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Failed to fetch data');
        }
        const jsonData = await response.json();
        res.status(200).json(jsonData);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Error fetching data' });
    }
}