// pages/api/caucasus-trains.js
// Thin alias of /api/operator-trains?source=caucasus (kept for back-compat).

import { createTrainsFileHandler } from "./lib/operator-trains-handler.mjs";

export default createTrainsFileHandler({
  file: "caucasus-trains.json",
  label: "caucasus-trains",
  missing: "empty",
});
