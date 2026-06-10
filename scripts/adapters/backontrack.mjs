// scripts/adapters/backontrack.mjs
// Back-on-Track community dataset: stops, view_ontd_map, trips (raw JSON on GitHub).
// Writes stops + trips immediately; view_ontd_map is held on ctx.shared so the
// runner can merge NightJet polylines + synthetic standalone routes into it
// before writing (post-step in scrape-data.mjs).

async function fetchBackontrack(baseUrl, type) {
  const res = await fetch(`${baseUrl}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${type}: ${res.status}`);
  return res.json();
}

export async function run(entry, ctx) {
  const baseUrl = entry.params?.baseUrl;
  const [stops, view_ontd_map, trips] = await Promise.all([
    fetchBackontrack(baseUrl, "stops"),
    fetchBackontrack(baseUrl, "view_ontd_map"),
    fetchBackontrack(baseUrl, "trips"),
  ]);
  ctx.write("backontrack-stops.json", stops);
  ctx.write("backontrack-trips.json", trips);
  ctx.shared.viewMap = view_ontd_map;
  ctx.shared.trips = trips;
}
