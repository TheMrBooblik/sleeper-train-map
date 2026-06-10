// pages/api/italian-trains.js
// Thin alias of /api/operator-trains?source=italian (kept for back-compat).

import { createTrainsFileHandler } from "./lib/operator-trains-handler";

export default createTrainsFileHandler({
  file: "italian-trains.json",
  label: "italian-trains",
  missing: "empty",
});
