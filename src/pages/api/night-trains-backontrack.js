// Returns only Nightjet (NJ) and EuroNight (EN) routes from Back-on-Track data.
// Reads from Vercel Blob (daily scrape) when fresh; falls back to GitHub.

import { getBlobData, isFresh } from "./lib/blob-store";

const BACKONTRACK_BASE =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

const isNightJetName = (s) => /^\s*NJ\s*\d+/.test(String(s || ""));
const isEuroNightName = (s) => /^\s*EN\s*\d+/.test(String(s || ""));

function routeIsNightTrain(route) {
  const t0 = (route?.trip_short_name_0 || "").toString();
  const t1 = (route?.trip_short_name_1 || "").toString();
  return isNightJetName(t0) || isNightJetName(t1) || isEuroNightName(t0) || isEuroNightName(t1);
}

async function fetchFromGithub(type) {
  const res = await fetch(`${BACKONTRACK_BASE}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${type}: ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  try {
    let viewMap, trips;

    const [blobView, blobTrips] = await Promise.all([
      getBlobData("view_ontd_map"),
      getBlobData("trips"),
    ]);

    if (blobView && isFresh(blobView.uploadedAt) && blobTrips && isFresh(blobTrips.uploadedAt)) {
      viewMap = blobView.data;
      trips = blobTrips.data;
    } else {
      [viewMap, trips] = await Promise.all([
        fetchFromGithub("view_ontd_map"),
        fetchFromGithub("trips"),
      ]);
    }

    const routes = {};
    Object.entries(viewMap || {}).forEach(([key, route]) => {
      if (route && routeIsNightTrain(route)) routes[key] = route;
    });

    const tripsFiltered = {};
    Object.entries(trips || {}).forEach(([key, trip]) => {
      const name = (trip?.trip_short_name || trip?.route_short_name || "").toString();
      if (isNightJetName(name) || isEuroNightName(name)) tripsFiltered[key] = trip;
    });

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ routes, trips: tripsFiltered });
  } catch (e) {
    console.error("[api/night-trains-backontrack]", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
