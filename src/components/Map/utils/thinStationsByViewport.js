export const ZOOM_SHOW_ALL_THRESHOLD = 8;

/**
 * Returns the grid cell size in degrees for a given zoom level.
 *
 * Sized so that two stations in the same cell would render within ~20 screen
 * pixels of each other — i.e. we only hide a station when there is a
 * higher-priority neighbour close enough to cause actual visual crowding.
 * The formula is zoom-level-dependent but viewport-position-independent, so
 * panning never changes which stations are shown.
 */
function getCellSizeDeg(zoom) {
  return (20 * 360) / (256 * Math.pow(2, zoom));
}

function countRouteIds(stopRouteIds) {
  if (!stopRouteIds) return 0;
  return stopRouteIds
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean).length;
}

function isFiniteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function getStationScore(stop, cities, normalizeStationNameForLookup) {
  const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
  const cityInfo = cities[normalizedStopId] || cities[stop.stop_id];
  const routeCount = countRouteIds(cityInfo?.stop_route_ids);
  const nonViaBonus = cityInfo?.isViaStation ? 0 : 1000;

  return nonViaBonus + routeCount;
}

function getStopKey(stop) {
  return `${stop?.stop_id || ""}|${stop?.stop_lat || ""}|${stop?.stop_lon || ""}`;
}

function splitVisibleAndHiddenStops(stops, visibleStops) {
  const visibleKeys = new Set(visibleStops.map(getStopKey));
  const hiddenStops = stops.filter(
    (stop) => !visibleKeys.has(getStopKey(stop)),
  );
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
 * - one "best" station per fixed world-coordinate grid cell
 *
 * Grid cells are fixed in world coordinates (not viewport-relative), so
 * panning never causes stations to appear or disappear. A station is only
 * hidden when a higher-priority station would render within ~30px of it.
 */
export function thinStationsByViewport({
  stops,
  cities,
  mapZoom,
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
        value: normalizeForAllowlistMatch(
          ruleValue,
          normalizeStationNameForLookup,
        ),
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
    return normalizedStopId === selectedNormalizedId || matchesAllowlist;
  };

  // Fixed world-coordinate grid: cell boundaries never shift with the viewport,
  // so panning does not change which station wins each cell.
  const cellSizeDeg = getCellSizeDeg(mapZoom);
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

    if (shouldAlwaysKeep(stop)) {
      const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
      if (!forcedStopsByName.has(normalizedStopId)) {
        forcedStopsByName.set(normalizedStopId, stop);
      }
      return;
    }

    const row = Math.floor(lat / cellSizeDeg);
    const col = Math.floor(lon / cellSizeDeg);
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
