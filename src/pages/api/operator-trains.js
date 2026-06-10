// pages/api/operator-trains.js
// Generic per-source trains endpoint: /api/operator-trains?source={registry id}.
// Serves the scraped { uploadedAt, trains } file declared by the registry entry.
// The legacy per-operator endpoints (/api/nightjet-trains etc.) are thin
// aliases of this for the same files.

import SOURCE_REGISTRY from "../../../data/sources/registry.json" with { type: "json" };
import { createTrainsFileHandler } from "./lib/operator-trains-handler";

// Handler per source, built once at module load.
const HANDLERS = new Map(
  SOURCE_REGISTRY.filter((e) => e.enabled && e.output).map((e) => [
    e.id,
    createTrainsFileHandler({
      file: e.output,
      label: e.id,
      missing: e.missingResponse || "empty",
    }),
  ]),
);

export default async function handler(req, res) {
  const id = (req.query.source || "").toString();
  const sourceHandler = HANDLERS.get(id);
  if (!sourceHandler) {
    return res.status(404).json({ error: `Unknown source "${id}"` });
  }
  return sourceHandler(req, res);
}
