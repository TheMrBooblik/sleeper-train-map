/**
 * Build-time enrichment: per-station times + coordinates from the raw operator
 * feeds (public/data/scraped/*-trains.json).
 *
 * The review-gated published payload keeps only endpoint times and a flat "via"
 * name list per route. The operators' own feeds (Nightjet, ČD, Trenitalia, …)
 * carry the full station sequence with arrival/departure times and coordinates —
 * we surface those on the per-train SEO page when they corroborate an already
 * published route (matched by train number + endpoint validation).
 *
 * Server/build only (uses fs). Memoized at module scope.
 */
import fs from "fs";
import path from "path";

const SCRAPED_DIR = "public/data/scraped";

let _index; // normalized train number -> cleaned station list

/** Normalize a train number for matching: "NJ 421" / "nj421" -> "NJ421". */
function normNumber(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "").trim();
}

/** Loose station-name equality (diacritics/punctuation/case insensitive, substring-tolerant). */
function looseNameEq(a, b) {
  const n = (x) =>
    String(x || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const A = n(a);
  const B = n(b);
  if (!A || !B) return false;
  return A === B || A.includes(B) || B.includes(A);
}

function readTrains(file) {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), SCRAPED_DIR, file), "utf8"),
    );
    // Tolerate the few container shapes in use: { trains }, { data: { trains } }, { data }.
    return j.trains || (j.data && j.data.trains) || (j.data && typeof j.data === "object" ? j.data : null) || null;
  } catch {
    return null;
  }
}

function cleanStations(entry) {
  const raw = Array.isArray(entry?.stations)
    ? entry.stations
    : Array.isArray(entry?.stops)
      ? entry.stops
      : null;
  if (!raw) return null;
  const out = raw
    .map((s) => {
      const lat = s?.location?.latitude ?? s?.lat ?? null;
      const lon = s?.location?.longitude ?? s?.lon ?? null;
      return {
        name: s?.name || s?.id || "",
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        arrival: s?.arrival || "",
        departure: s?.departure || "",
      };
    })
    .filter((s) => s.name);
  return out.length >= 2 ? out : null;
}

/** Lazily build { normalizedTrainNumber -> station[] } across every raw operator feed. */
function loadIndex() {
  if (_index) return _index;
  _index = new Map();
  let files = [];
  try {
    files = fs
      .readdirSync(path.join(process.cwd(), SCRAPED_DIR))
      .filter((f) => /-trains\.json$/.test(f));
  } catch {
    files = [];
  }
  for (const file of files) {
    const trains = readTrains(file);
    if (!trains || typeof trains !== "object") continue;
    for (const [key, entry] of Object.entries(trains)) {
      const stations = cleanStations(entry);
      if (!stations) continue;
      // Index under the entry key and any train-number-bearing field, so a route's
      // trip_short_name ("NJ 421", "ICN 752", "EC 345") resolves regardless of source.
      for (const id of [key, entry.lineName, entry.trainNumber, entry.trainLabel]) {
        const k = normNumber(id);
        if (k && !_index.has(k)) _index.set(k, stations);
      }
    }
  }
  return _index;
}

/**
 * Full station list (names + times + coords) for a train, or null when no raw feed
 * corroborates it. When origin/destination are given, the feed's endpoints must match
 * (guards against train-number collisions across operators).
 *
 * @param {string} trainNumber
 * @param {{ origin?: string, destination?: string }} [endpoints]
 * @returns {{ name:string, lat:number|null, lon:number|null, arrival:string, departure:string }[] | null}
 */
export function getStationTimesForTrain(trainNumber, { origin, destination } = {}) {
  const stations = loadIndex().get(normNumber(trainNumber));
  if (!stations) return null;
  if (origin && destination) {
    const first = stations[0].name;
    const last = stations[stations.length - 1].name;
    if (!(looseNameEq(first, origin) && looseNameEq(last, destination))) return null;
  }
  return stations;
}
