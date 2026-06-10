// pages/api/cd-trains.js
// Thin alias of /api/operator-trains?source=cd (kept for back-compat).
// Serves Czech Railways (cd.cz) EC/EN timetables from the daily scrape.

import { createTrainsFileHandler } from "./lib/operator-trains-handler";

export default createTrainsFileHandler({
  file: "cd-trains.json",
  label: "CD train",
  missing: "404",
});
