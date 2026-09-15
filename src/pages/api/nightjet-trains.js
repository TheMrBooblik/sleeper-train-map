// pages/api/nightjet-trains.js
// Thin alias of /api/operator-trains?source=nightjet (kept for back-compat).
// Serves the NightJet / EuroNight trains file written by the daily scrape as
// { uploadedAt, trains: { "NJ 403": { stations, polyline, ... }, ... } }.

import { createTrainsFileHandler } from "./lib/operator-trains-handler.mjs";

export default createTrainsFileHandler({
  file: "nightjet-trains.json",
  label: "nightjet-trains",
  missing: "empty",
});
