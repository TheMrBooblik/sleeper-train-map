const ZOOM_SHOW_ALL_THRESHOLD = 8;

function countRouteIds(stopRouteIds) {
  if (!stopRouteIds) return 0;
  return stopRouteIds
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean).length;
}

function getGridDimensions(zoom) {
  // Lower zoom means wider view, so we keep fewer markers.
  // Slightly denser than before, as requested:
  // - zoom 0-3: from 10x10 -> 12x12
  // - zoom 4-5: from 16x16 -> 20x20
  if (zoom <= 3) return { rows: 12, cols: 12 };
  return { rows: 20, cols: 20 };
}

function isFiniteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isInBounds(lat, lon, bounds) {
  return (
    lat >= bounds.south &&
    lat <= bounds.north &&
    lon >= bounds.west &&
    lon <= bounds.east
  );
}

// `normalizedStopId` is passed in because the caller's loop has already
// computed it: normalising a station name is the only non-trivial per-stop cost
// left in this function, and it was being done three times per stop on every
// pan frame.
function getStationScore(
  stop,
  cities,
  normalizeStationNameForLookup,
  normalizedStopId = normalizeStationNameForLookup(stop.stop_id),
) {
  const cityInfo = cities[normalizedStopId] || cities[stop.stop_id];
  const routeCount = countRouteIds(cityInfo?.stop_route_ids);
  const nonViaBonus = cityInfo?.isViaStation ? 0 : 1000;

  // Keep scoring simple and predictable:
  // - prefer non-via stations
  // - then prefer stations serving more routes
  return nonViaBonus + routeCount;
}

function getStopKey(stop) {
  return `${stop?.stop_id || ""}|${stop?.stop_lat || ""}|${stop?.stop_lon || ""}`;
}

function splitVisibleAndHiddenStops(stops, visibleStops) {
  const visibleKeys = new Set(visibleStops.map(getStopKey));
  const hiddenStops = stops.filter((stop) => !visibleKeys.has(getStopKey(stop)));
  return { visibleStops, hiddenStops };
}

function normalizeForAllowlistMatch(value, normalizeStationNameForLookup) {
  const normalized = normalizeStationNameForLookup(value);
  return typeof normalized === "string" ? normalized.trim().toLowerCase() : "";
}

/**
 * Reduce marker density for zoomed-out views by keeping:
 * - always-show stations (manual allowlist)
 * - currently selected station
 * - one "best" station per grid cell for remaining candidates
 */
export function thinStationsByViewport({
  stops,
  cities,
  mapZoom,
  mapBounds,
  normalizeStationNameForLookup,
  alwaysShowStations,
  selectedStopId,
}) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return { visibleStops: [], hiddenStops: [] };
  }
  if (mapZoom == null || mapZoom >= ZOOM_SHOW_ALL_THRESHOLD) {
    return { visibleStops: stops, hiddenStops: [] };
  }

  // Exact rules in a Set, prefix rules in a list — because this runs on every
  // pan and zoom frame, and the rule list is mostly not a curated allowlist.
  // The caller appends every endpoint of every route (they must not vanish
  // when zoomed out), so `alwaysShowStations` is ~1 100 entries of which
  // exactly one, "Frankfurt*", is a prefix. Scanning all of them per stop made
  // this 1 863 × 1 136 ≈ 2.1 million string comparisons a frame — 14 ms
  // against a 16.7 ms budget, which is the map's "lags when you drag it", and
  // it grows with every stop an official stop list adds. A Set lookup plus one
  // prefix check is the same answer in constant time.
  const exactRules = new Set();
  const prefixRules = [];
  for (const name of alwaysShowStations || []) {
    const rawRule = typeof name === "string" ? name.trim() : "";
    if (!rawRule) continue;
    const isPrefixRule = rawRule.endsWith("*");
    const value = normalizeForAllowlistMatch(
      isPrefixRule ? rawRule.slice(0, -1) : rawRule,
      normalizeStationNameForLookup,
    );
    if (!value) continue;
    if (isPrefixRule) prefixRules.push(value);
    else exactRules.add(value);
  }
  const selectedNormalizedId = selectedStopId
    ? normalizeForAllowlistMatch(selectedStopId, normalizeStationNameForLookup)
    : null;

  // Takes the already-normalised id where the caller has one: the main loop
  // normalises every stop_id anyway, and doing it twice per stop doubled the
  // only other per-stop cost in here.
  const shouldAlwaysKeepNormalized = (normalizedForMatch) => {
    if (!normalizedForMatch) return false;
    if (normalizedForMatch === selectedNormalizedId) return true;
    if (exactRules.has(normalizedForMatch)) return true;
    return prefixRules.some((value) => normalizedForMatch.startsWith(value));
  };

  const shouldAlwaysKeep = (stop) =>
    !!stop?.stop_id &&
    shouldAlwaysKeepNormalized(
      normalizeForAllowlistMatch(stop.stop_id, normalizeStationNameForLookup),
    );

  // On first render we may not have bounds yet. Keep only forced markers
  // to avoid dense "flash" at low zoom.
  if (!mapBounds) {
    return splitVisibleAndHiddenStops(stops, stops.filter(shouldAlwaysKeep));
  }

  const { north, south, east, west } = mapBounds;
  const validBounds =
    [north, south, east, west].every(isFiniteCoordinate) &&
    north > south &&
    east > west;

  if (!validBounds) {
    return splitVisibleAndHiddenStops(stops, stops.filter(shouldAlwaysKeep));
  }

  const latSpan = north - south;
  const lonSpan = east - west;
  const { rows, cols } = getGridDimensions(mapZoom);
  const cellLat = latSpan / rows;
  const cellLon = lonSpan / cols;

  if (cellLat <= 0 || cellLon <= 0) {
    return splitVisibleAndHiddenStops(stops, stops.filter(shouldAlwaysKeep));
  }

  const forcedStopsByName = new Map();
  const winnersByCell = new Map();

  stops.forEach((stop) => {
    const lat = stop?.stop_lat;
    const lon = stop?.stop_lon;
    if (
      !stop?.stop_id ||
      !isFiniteCoordinate(lat) ||
      !isFiniteCoordinate(lon)
    ) {
      return;
    }

    const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
    const normalizedForMatch =
      typeof normalizedStopId === "string"
        ? normalizedStopId.trim().toLowerCase()
        : "";
    if (shouldAlwaysKeepNormalized(normalizedForMatch)) {
      if (!forcedStopsByName.has(normalizedStopId)) {
        forcedStopsByName.set(normalizedStopId, stop);
      }
      return;
    }

    if (!isInBounds(lat, lon, mapBounds)) return;

    const row = Math.max(
      0,
      Math.min(rows - 1, Math.floor((lat - south) / cellLat)),
    );
    const col = Math.max(
      0,
      Math.min(cols - 1, Math.floor((lon - west) / cellLon)),
    );
    const cellKey = `${row}:${col}`;
    const candidateScore = getStationScore(
      stop,
      cities,
      normalizeStationNameForLookup,
      normalizedStopId,
    );

    const existing = winnersByCell.get(cellKey);
    if (!existing || candidateScore > existing.score) {
      winnersByCell.set(cellKey, { stop, score: candidateScore });
    }
  });

  const visibleStops = [
    ...forcedStopsByName.values(),
    ...Array.from(winnersByCell.values()).map((entry) => entry.stop),
  ];
  return splitVisibleAndHiddenStops(stops, visibleStops);
}
