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

function getStationScore(stop, cities, normalizeStationNameForLookup) {
  const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
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

  const alwaysShowRules = (alwaysShowStations || [])
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter(Boolean)
    .map((rawRule) => {
      const isPrefixRule = rawRule.endsWith("*");
      const ruleValue = isPrefixRule ? rawRule.slice(0, -1) : rawRule;
      return {
        isPrefixRule,
        value: normalizeForAllowlistMatch(ruleValue, normalizeStationNameForLookup),
      };
    })
    .filter((rule) => rule.value);
  const selectedNormalizedId = selectedStopId
    ? normalizeForAllowlistMatch(selectedStopId, normalizeStationNameForLookup)
    : null;

  const shouldAlwaysKeep = (stop) => {
    if (!stop?.stop_id) return false;
    const normalizedStopId = normalizeForAllowlistMatch(
      stop.stop_id,
      normalizeStationNameForLookup,
    );
    const matchesAllowlist = alwaysShowRules.some((rule) =>
      rule.isPrefixRule
        ? normalizedStopId.startsWith(rule.value)
        : normalizedStopId === rule.value,
    );
    return (
      normalizedStopId === selectedNormalizedId ||
      matchesAllowlist
    );
  };

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
    if (shouldAlwaysKeep(stop)) {
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
