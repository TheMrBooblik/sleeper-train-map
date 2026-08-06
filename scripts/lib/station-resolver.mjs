// scripts/lib/station-resolver.mjs
// Resolve a station name coming from an official feed to the SAME station in the
// map's own stop table (Back-on-Track stops), returning its canonical spelling
// and coordinates.
//
// Why this exists: the PLK Open Data API has no coordinates at all (its station
// dictionary is {id, name}), so PLK station lists can only reach the map by
// naming a station the stop table already knows. PLK spells names ASCII-folded
// or in an alternate form — "Praha Hlavni Nadrazi" for "Praha hl.n.", "Ceska
// Trebova" for "Česká Třebová", "Bydgoszcz Główna" for "Bydgoszcz Gł.". Those
// names silently fail the renderer's exact-name lookup, so the station gets no
// map dot AND is dropped from the chained route line — the line then shortcuts
// straight across everything it skipped (e.g. the whole Czech leg of EN 50443).
//
// The fix is a "folded" comparison: strip diacritics and punctuation, then
// normalise the three station-name qualifiers that differ purely by spelling
// convention (Polish "Główna"/"Gł.", Czech "hlavní nádraží"/"hl.n.", German
// "Hauptbahnhof"/"Hbf"). That resolves every PLK name we have seen to a stop
// that already exists — no new stations, no new coordinate source.
//
// Folding is deliberately lossy, so it can produce a genuine collision between
// two different stations ("Sopot" in Poland vs "Šopot" in Croatia, ~980 km
// apart). resolveStationList() therefore disambiguates geographically: an
// ambiguous name picks the candidate nearest to the nearest UNambiguous station
// on the same route. That is exactly the property the route line needs.

/**
 * Normalise a station name for lossy comparison.
 * Diacritics dropped, punctuation collapsed to single spaces, and the
 * main-station qualifiers reduced to one token each so the abbreviated and
 * spelled-out forms of the same station fold together.
 * @param {string} name
 * @returns {string} the fold key ("" when there is nothing to compare)
 */
export function foldStationName(name) {
  if (!name) return "";
  const ascii = String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining accents: é → e
    .replace(/[łŁ]/g, "l") // Polish ł has no decomposed form
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return ascii
    .replace(/\bhlavni nadrazi\b|\bhlavni\b|\bhl n\b|\bhl\b/g, "~hl")
    .replace(/\bhauptbahnhof\b|\bhbf\b/g, "~hb")
    .replace(/\bglowna\b|\bglowny\b|\bglowne\b|\bgl\b/g, "~gl")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Index the map's stop table for both exact and folded lookups.
 * Accepts the Back-on-Track stops shape ({stop_name, stop_lat, stop_lon}), as
 * an array or an object of rows.
 * @param {object[]|object} stops
 * @returns {{exact: Map<string, object>, folded: Map<string, object[]>}}
 */
export function buildStationIndex(stops) {
  const exact = new Map();
  const folded = new Map();
  const rows = Array.isArray(stops) ? stops : Object.values(stops ?? {});

  for (const row of rows) {
    const name = row?.stop_name ?? row?.name;
    const lat = row?.stop_lat ?? row?.lat;
    const lon = row?.stop_lon ?? row?.lon;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const station = { name: String(name), lat, lon };
    const exactKey = station.name.toLowerCase().trim();
    // First writer wins, matching the renderer's own stop-table behaviour.
    if (!exact.has(exactKey)) exact.set(exactKey, station);

    const foldKey = foldStationName(station.name);
    if (!foldKey) continue;
    if (!folded.has(foldKey)) folded.set(foldKey, []);
    folded.get(foldKey).push(station);
  }
  return { exact, folded };
}

// Two candidates closer than this are treated as the same place (the stop table
// carries duplicates like "Gdynia Gł." / "Gdynia Główna" at identical coords).
const SAME_PLACE_KM = 25;

/** Rough great-circle distance in km — good enough to tell 20 km from 900 km. */
function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * 111;
  const dLon = (a.lon - b.lon) * 111 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

/**
 * Candidate stations for one name: every station sharing its fold key, with the
 * exactly-named one first.
 *
 * An exact match is NOT taken as final. The stop table really does contain
 * "Kolin" (Poland) next to "Kolín" (Czechia), so trusting the exact hit would
 * pull a Czech corridor 200 km north. Keeping the whole fold group lets
 * resolveStationList() decide geographically; ordering the exact match first
 * makes it win ties and the no-anchor fallback.
 * @returns {object[]} possibly empty
 */
function candidatesFor(name, index) {
  if (!name) return [];
  const hit = index.exact.get(String(name).toLowerCase().trim());
  const group = index.folded.get(foldStationName(name)) ?? [];
  if (group.length === 0) return hit ? [hit] : [];
  return hit ? [hit, ...group.filter((s) => s !== hit)] : group;
}

/**
 * Resolve an ORDERED list of station names against the stop table.
 *
 * Two passes so ambiguity is settled geographically rather than by luck:
 *   1. names with exactly one candidate become anchors;
 *   2. every remaining name picks the candidate closest to its nearest anchor,
 *      which keeps the resolved list on one corridor instead of teleporting to
 *      a same-named station in another country.
 *
 * @param {string[]} names  station names in travel order
 * @param {{exact: Map, folded: Map}} index  from buildStationIndex()
 * @returns {(object|null)[]} one {name, lat, lon} per input name (null = unknown)
 */
export function resolveStationList(names, index) {
  const list = Array.isArray(names) ? names : [];
  const options = list.map((n) => candidatesFor(n, index));
  const resolved = options.map((o) => (o.length === 1 ? o[0] : null));

  for (let i = 0; i < options.length; i += 1) {
    if (resolved[i] || options[i].length === 0) continue;
    // Nearest already-resolved anchor, searching outwards from this position.
    let anchor = null;
    for (let d = 1; d < options.length && !anchor; d += 1) {
      anchor = resolved[i - d] ?? resolved[i + d] ?? null;
    }
    resolved[i] = anchor
      ? options[i].reduce((best, c) =>
          // Only a MEANINGFULLY closer candidate displaces the first option
          // (the exact-name match). Otherwise "Gdynia Gł." would be rewritten
          // to its duplicate "Gdynia Główna" at the very same coordinates, for
          // no gain. Real collisions are hundreds of km apart, so this bias
          // never blocks a genuine correction.
          distanceKm(c, anchor) + SAME_PLACE_KM < distanceKm(best, anchor)
            ? c
            : best,
        )
      : options[i][0]; // nothing to compare against — first writer wins
  }
  return resolved;
}
