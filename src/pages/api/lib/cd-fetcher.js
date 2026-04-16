// lib/cd-fetcher.js
// Fetches EC train timetables from Czech Railways (cd.cz) HTML pages.
// No public JSON API exists — data is embedded in a `var model = {...}` script tag.

const FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(id),
  );
}

/**
 * Extract EC train numeric IDs from Back-on-Track trips data.
 * Filters trip_short_name values matching "EC NNN" and deduplicates.
 *
 * @param {Object} trips - Back-on-Track trips object keyed by trip_id
 * @returns {string[]} Array of numeric EC train IDs (e.g. ["460", "102"])
 */
export function extractECNumbers(trips) {
  if (!trips || typeof trips !== "object") return [];

  const seen = new Set();
  for (const trip of Object.values(trips)) {
    const name = (trip.trip_short_name || "").toString().trim();
    const match = name.match(/^\s*EC\s+(\d+)/i);
    if (match) seen.add(match[1]);
  }
  return Array.from(seen);
}

/**
 * Parse the embedded JSON model from a cd.cz train page HTML response.
 * Tries multiple extraction strategies to handle JS-vs-JSON differences.
 *
 * @param {string} html
 * @param {string|number} trainNumber
 * @returns {{ trainNumber, trainLabel, fetchedAt, stops }|null}
 */
function parseCDTrainHTML(html, trainNumber, trainType = "EC") {
  // Strategy 1: extract `var model = {...}` up to `new TrainDetail` and JSON.parse
  try {
    const match = html.match(/var\s+model\s*=\s*([\s\S]+?);\s*new\s+TrainDetail/);
    if (match) {
      const model = JSON.parse(match[1]);
      const route = model?.trainDetailTimetable?.route;
      if (Array.isArray(route) && route.length > 0) {
        return buildResult(trainNumber, route, trainType);
      }
    }
  } catch {
    // fall through to Strategy 2
  }

  // Strategy 2: narrow regex targeting just the route array inside trainDetailTimetable
  try {
    const match = html.match(/"trainDetailTimetable"\s*:\s*\{[^}]*"route"\s*:\s*(\[[\s\S]+?\])\s*\}/);
    if (match) {
      const route = JSON.parse(match[1]);
      if (Array.isArray(route) && route.length > 0) {
        return buildResult(trainNumber, route, trainType);
      }
    }
  } catch {
    // fall through
  }

  // Strategy 3: unquoted keys variant (trainDetailTimetable: { route: [...] })
  try {
    const match = html.match(/trainDetailTimetable\s*:\s*\{[^}]*route\s*:\s*(\[[\s\S]+?\])\s*\}/);
    if (match) {
      const route = JSON.parse(match[1]);
      if (Array.isArray(route) && route.length > 0) {
        return buildResult(trainNumber, route, trainType);
      }
    }
  } catch {
    // all strategies exhausted
  }

  return null;
}

function buildResult(trainNumber, route, trainType = "EC") {
  const stops = route
    .map((stop) => ({
      name: stop.name || stop.stationName || null,
      arrival: stop.timeArr || null,
      departure: stop.timeDep || null,
    }))
    .filter((s) => s.name);

  if (stops.length === 0) return null;

  return {
    trainNumber: String(trainNumber),
    trainLabel: `${trainType} ${trainNumber}`,
    fetchedAt: new Date().toISOString(),
    stops,
  };
}

/**
 * Extract EC train numeric IDs from Back-on-Track trips data for EN trains.
 * Filters trip_short_name values matching "EN NNN" and deduplicates.
 *
 * @param {Object} trips - Back-on-Track trips object keyed by trip_id
 * @returns {string[]} Array of numeric EN train IDs (e.g. ["443"])
 */
export function extractENNumbers(trips) {
  if (!trips || typeof trips !== "object") return [];

  const seen = new Set();
  for (const trip of Object.values(trips)) {
    const name = (trip.trip_short_name || "").toString().trim();
    const match = name.match(/^\s*EN\s+(\d+)/i);
    if (match) seen.add(match[1]);
  }
  return Array.from(seen);
}

/**
 * Fetch and parse an EC or EN train timetable from cd.cz.
 *
 * @param {string|number} trainNumber - train number (e.g. 460, 443)
 * @param {string} [trainType="EC"] - train type prefix for the label ("EC" or "EN")
 * @returns {Promise<{ trainNumber, trainLabel, fetchedAt, stops }|null>}
 */
export async function fetchCDTrain(trainNumber, trainType = "EC") {
  const url = `https://www.cd.cz/en/vlak/${trainNumber}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "train-map/1.0 (timetable-display)",
        Accept: "text/html",
      },
    });
    if (!res.ok) {
      console.warn(`[cd-fetcher] HTTP ${res.status} for ${trainType} ${trainNumber}`);
      return null;
    }
    const html = await res.text();
    const result = parseCDTrainHTML(html, trainNumber, trainType);
    if (!result) {
      console.warn(`[cd-fetcher] parse failed for ${trainType} ${trainNumber}`);
    }
    return result;
  } catch (e) {
    console.warn(`[cd-fetcher] fetch failed for ${trainType} ${trainNumber}: ${e.message}`);
    return null;
  }
}
