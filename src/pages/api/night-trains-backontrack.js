// Returns only Nightjet (NJ) and EuroNight (EN) routes from Back-on-Track data.
// Used as fallback when official Nightjet/EuroNight API is missing some trains.

const BACKONTRACK_BASE =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

const isNightJetName = (s) => /^\s*NJ\s*\d+/.test(String(s || ""));
const isEuroNightName = (s) => /^\s*EN\s*\d+/.test(String(s || ""));

function routeIsNightTrain(route) {
  const t0 = (route?.trip_short_name_0 || "").toString();
  const t1 = (route?.trip_short_name_1 || "").toString();
  return isNightJetName(t0) || isNightJetName(t1) || isEuroNightName(t0) || isEuroNightName(t1);
}

export default async function handler(req, res) {
  try {
    const [viewRes, tripsRes] = await Promise.all([
      fetch(`${BACKONTRACK_BASE}/view_ontd_map.json`, {
        headers: { "Accept-Encoding": "gzip, deflate, br" },
      }),
      fetch(`${BACKONTRACK_BASE}/trips.json`, {
        headers: { "Accept-Encoding": "gzip, deflate, br" },
      }),
    ]);

    if (!viewRes.ok || !tripsRes.ok) {
      return res.status(502).json({
        error: "backontrack_fetch_failed",
        viewOk: viewRes.ok,
        tripsOk: tripsRes.ok,
      });
    }

    const viewMap = await viewRes.json();
    const trips = await tripsRes.json();

    // Filter to routes that are NJ or EN (same logic as trains.js but keep these instead of removing)
    const routesFiltered = {};
    Object.entries(viewMap || {}).forEach(([key, route]) => {
      if (route && routeIsNightTrain(route)) {
        routesFiltered[key] = route;
      }
    });

    // Filter trips to only NJ/EN (so frontend can resolve route_id -> line name)
    const tripsFiltered = {};
    Object.entries(trips || {}).forEach(([key, trip]) => {
      const name = (trip?.trip_short_name || trip?.route_short_name || "").toString();
      if (isNightJetName(name) || isEuroNightName(name)) {
        tripsFiltered[key] = trip;
      }
    });

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({
      routes: routesFiltered,
      trips: tripsFiltered,
    });
  } catch (e) {
    console.error("[api/night-trains-backontrack]", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
