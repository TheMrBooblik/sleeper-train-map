import { splitViaString, VIA_SEPARATOR } from "../viaSplit.mjs";

/**
 * Pure formatting helpers for the SEO pages. Its one import is viaSplit.mjs,
 * which is itself dependency-free — the rule this header states is about
 * staying trivially testable and safe to run at build time, and a pure module
 * with no imports of its own keeps both. It is imported rather than copied
 * because the copy is exactly what went wrong: parseViaList held the twelfth
 * hand-rolled split of a via string, and the only one that reached a public
 * page.
 *
 * Two time encodings exist in the published data:
 *   - viewMap times are clean "HH:MM" strings ("21:03").
 *   - trips times/duration are Excel-epoch ISO strings ("1899-12-30T19:28:00.000Z").
 */

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30, 0, 0, 0, 0); // 1899-12-30T00:00:00Z

/**
 * Format a clock time from either a clean "HH:MM" string or an Excel-epoch ISO
 * string. Returns "" when the value cannot be interpreted.
 * @param {string} value
 * @returns {string} "HH:MM" or ""
 */
export function formatAnyTime(value) {
  if (!value) return "";
  const str = String(value).trim();
  const hhmm = str.match(/^(\d{1,2}):(\d{2})/);
  if (hhmm) {
    return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  }
  const ts = Date.parse(str);
  if (Number.isNaN(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

/**
 * Total minutes for a trip duration (Excel-epoch ISO), or 0 when unreadable.
 * Kept separate from formatDuration so callers can sort routes by length
 * (fastest/longest) without re-parsing the human-readable string.
 * @param {string} value
 * @returns {number}
 */
export function durationToMinutes(value) {
  if (!value) return 0;
  const ts = Date.parse(String(value));
  if (Number.isNaN(ts)) return 0;
  const total = Math.round((ts - EXCEL_EPOCH_MS) / 60000);
  return total > 0 ? total : 0;
}

/**
 * Format a trip duration (Excel-epoch ISO) as "12h 47m". Handles durations over
 * 24h by measuring elapsed time from the Excel epoch rather than reading the clock.
 * @param {string} value
 * @returns {string}
 */
export function formatDuration(value) {
  const totalMinutes = durationToMinutes(value);
  if (totalMinutes <= 0) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * Journey length in minutes for a route, preferring its own endpoint times.
 *
 * Trips carry Back-on-Track's duration, which goes stale independently of the
 * times: European Sleeper's Berlin–Paris trip still claims 18h32 while the row's
 * feed-enriched times say 17:52 → 10:57, i.e. 17h05. When an official source has
 * stamped the row, its times are the authority, so the duration is measured from
 * them; every other route keeps the trip's stated value. Across the published
 * payload this changes exactly the two rows whose numbers contradict each other.
 *
 * @param {{ official_sources?: string[], origin_departure_time_0?: string, destination_arrival_time_0?: string }} route
 * @param {{ duration?: string }} trip
 * @returns {number} minutes, 0 when unknown
 */
export function routeDurationMinutes(route, trip) {
  // A source that dates every stop states the journey time on the row: two
  // clocks cannot say a 33-hour train is not a 9-hour one.
  const own = Number(route?.duration_minutes_0);
  if (Number.isInteger(own) && own > 0) return own;
  const stated = durationToMinutes(trip?.duration);
  if (!route?.official_sources?.length) return stated;

  const clock = (value) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = clock(route.origin_departure_time_0);
  const to = clock(route.destination_arrival_time_0);
  if (from === null || to === null) return stated;

  // Sleepers arrive the next morning; a same-clock arrival means no data, not a
  // 24-hour ride, so fall back rather than invent a day.
  const span = (to - from + 24 * 60) % (24 * 60);
  return span > 0 ? span : stated;
}

/**
 * Format a duration given in minutes as "12h 47m".
 * @param {number} totalMinutes
 * @returns {string}
 */
export function formatDurationMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * "604 km" or "" when distance is missing/zero.
 * @param {number} value
 * @returns {string}
 */
export function formatDistanceKm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.round(n)} km`;
}

/**
 * "14 kg CO₂e" or "" when missing/zero.
 * @param {number} value
 * @returns {string}
 */
export function formatCo2(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.round(n)} kg CO₂e`;
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Compact "from …" label for a not-yet-running train, given the future start
 * date the map's getFutureRouteStartDate() returns ("YYYY-MM-DD").
 *
 * A date of the 1st of January means the source only gave us a year (e.g. a
 * "postponed to 2027" note the map normalises to YYYY-01-01), so we show just
 * the year — "from 2027". Otherwise we show the day — "from 9 Sep 2026".
 * Returns "" when there is no future date.
 * @param {string} dateStr - "YYYY-MM-DD" or falsy
 * @returns {string}
 */
export function formatFutureFrom(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return "";
  if (m === 1 && d === 1) return `from ${y}`;
  return `from ${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/**
 * Split a hyphen-separated "via" string into a clean list of station names.
 * "Knin - Gospić - Karlovac" → ["Knin", "Gospić", "Karlovac"].
 * @param {string} value
 * @returns {string[]}
 */
export function parseViaList(value, isKnownStation = null) {
  if (!value) return [];
  // The separator is also part of 437 station names, so splitting on it alone
  // invents places: "Rocamadour - Padirac" became "Rocamadour" and "Padirac",
  // two names no stop answers to, printed on the connection page as though
  // they were stations. Given a station table, split by what a station is
  // CALLED. Whitespace is normalised first so the old regex's tolerance of
  // "A  -  B" survives; a hyphen inside a name ("Mont-Dauphin") never had
  // spaces around it and was never at risk either way.
  const normalized = String(value).replace(/\s+-\s+/g, VIA_SEPARATOR);
  return splitViaString(normalized, isKnownStation);
}

/**
 * Display title for a route: the official long name, or "Origin – Destination".
 * @param {{ route_long_name?: string }} route
 * @param {string} origin
 * @param {string} destination
 * @returns {string}
 */
export function deriveTitle(route, origin, destination) {
  const longName = (route?.route_long_name || "").trim();
  if (longName) return longName;
  if (origin && destination) return `${origin} – ${destination}`;
  return origin || destination || "Night train";
}
