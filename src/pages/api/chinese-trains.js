// pages/api/chinese-trains.js
// Thin alias of /api/operator-trains?source=chinese (kept for back-compat).

import { createTrainsFileHandler } from "./lib/operator-trains-handler";

export default createTrainsFileHandler({
  file: "chinese-trains.json",
  label: "chinese-trains",
  missing: "empty",
});
