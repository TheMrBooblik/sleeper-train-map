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
 * Server/build only (uses fs). Memoized at module scope. `.mjs` so raw-node
 * tests and the Next build run the identical module — the same reason
 * slugify.mjs is not a .js.
 */
import fs from "fs";
import path from "path";

// From primitives.mjs rather than src/data/stationAliases.js: same table, but
// the .mjs one imports its JSON with an import attribute, so raw `node` can
// load this module and the unit suite can exercise it without a build.
import { resolveCanonicalStationName } from "../../pages/api/lib/primitives.mjs";

const SCRAPED_DIR = "public/data/scraped";

let _index; // normalized train number -> [{ file, stations }, …], every feed that claims it

/** Normalize a train number for matching: "NJ 421" / "nj421" -> "NJ421". */
function normNumber(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "").trim();
}

/**
 * Loose station-name equality (diacritics/punctuation/case insensitive,
 * substring-tolerant). Both sides go through the alias table first, so a feed's
 * exonym validates against the canonical name the route row carries (Nightjet
 * says "Prag Hbf" where Back-on-Track says "Praha hl.n.") — without it those
 * feeds failed endpoint validation and their whole timetable was dropped.
 */
function looseNameEq(a, b) {
  const n = (x) =>
    String(resolveCanonicalStationName(String(x || "").trim()) || "")
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
        // Canonical spelling, so a page does not say "Praha hl.n." in the route
        // heading and "Prag Hbf" three lines below it — the feeds carry their
        // own exonyms and the rest of the app indexes stations by the
        // Back-on-Track name.
        name: resolveCanonicalStationName(s?.name || s?.id || ""),
        // GTFS stop code where the feed carries one (Amtrak/VIA) — used to
        // build station-preselected booking deep links.
        code: s?.code || null,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        arrival: s?.arrival || "",
        departure: s?.departure || "",
      };
    })
    .filter((s) => s.name);
  return out.length >= 2 ? out : null;
}

/**
 * Lazily build { normalizedTrainNumber -> [{ file, stations }, …] } across every
 * raw operator feed.
 *
 * Every claimant is kept, not just the first. A bare number is only unique
 * WITHIN an operator — European Sleeper's feed is keyed "452"/"475" while ČD's
 * is keyed "460"/"476" and Nightjet's "NJ 421" — so one flat first-wins map let
 * whichever file readdir returned first shadow the right train, and the
 * endpoint check downstream then rejected it and dropped the timetable
 * altogether. Holding the candidates lets that check pick the correct feed.
 */
function loadIndex() {
  if (_index) return _index;
  _index = new Map();
  let files = [];
  try {
    files = fs
      .readdirSync(path.join(process.cwd(), SCRAPED_DIR))
      .filter((f) => /-trains\.json$/.test(f))
      .sort(); // stable across filesystems, so a build is reproducible
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
      const keys = new Set(
        [key, entry.lineName, entry.trainNumber, entry.trainLabel]
          .map(normNumber)
          .filter(Boolean),
      );
      for (const k of keys) {
        if (!_index.has(k)) _index.set(k, []);
        const bucket = _index.get(k);
        if (!bucket.some((c) => c.file === file && c.stations === stations)) {
          bucket.push({ file, stations });
        }
      }
    }
  }
  return _index;
}

/**
 * Full station list (names + times + coords) for a train, or null when no raw feed
 * corroborates it. When origin/destination are given, the endpoints must match —
 * which is both the guard against train-number collisions across operators AND
 * how the right feed is chosen when several claim the same number.
 *
 * @param {string} trainNumber
 * @param {{ origin?: string, destination?: string }} [endpoints]
 * @returns {{ name:string, code:string|null, lat:number|null, lon:number|null, arrival:string, departure:string }[] | null}
 */
export function getStationTimesForTrain(trainNumber, { origin, destination } = {}) {
  const candidates = loadIndex().get(normNumber(trainNumber));
  if (!candidates || candidates.length === 0) return null;
  // With no endpoints to check against there is nothing to tell the claimants
  // apart, so the first one stands — same behaviour as before.
  if (!origin || !destination) return candidates[0].stations;
  for (const { stations } of candidates) {
    const first = stations[0].name;
    const last = stations[stations.length - 1].name;
    if (looseNameEq(first, origin) && looseNameEq(last, destination)) return stations;
  }
  return null;
}
