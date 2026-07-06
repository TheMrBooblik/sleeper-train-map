// scripts/lib/pkp-calendar.mjs
// Pure calendar/time helpers shared by the PKP data scripts. Dependency-free so
// both the raw-node GTFS parser and the ESM PLK adapter can use them.
//
// The mkuran GTFS parser (scripts/parse-pkp-gtfs.js, CommonJS) keeps its own
// inline copies for now; these ESM exports are the shared home the PLK adapter
// (scripts/adapters/pkp-plk.mjs) uses and that parse-pkp-gtfs.js can adopt later.

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format a time to a short "HH:MM" wall-clock string. Accepts either an ISO
 * DateTime ("2025-10-21T18:13:00", optionally with Z/offset — PLK's
 * plannedArrival/plannedDeparture) or a GTFS/TimeSpan "HH:MM:SS" (possibly
 * >= 24h, which wraps to next-day). Returns null when it can't parse.
 * @param {string} value
 * @returns {string|null}
 */
export function fmtHHMM(value) {
  if (!value || typeof value !== "string") return null;

  // ISO DateTime: pull the wall-clock HH:MM after the "T".
  const iso = value.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;

  // TimeSpan / GTFS clock: "18:13", "18:13:00", or "1.18:13:00" (d.HH:MM:SS).
  const span = value.match(/(?:\d+\.)?(\d{1,2}):(\d{2})/);
  if (span) {
    let h = Number.parseInt(span[1], 10);
    if (!Number.isFinite(h)) return null;
    h %= 24; // 25:30 -> 01:30
    return `${String(h).padStart(2, "0")}:${span[2]}`;
  }
  return null;
}

/**
 * Summarise a set of explicit run-dates into a display window + weekday pattern,
 * mirroring the GTFS parser's summariseCalendar. Dates may be "YYYYMMDD" or
 * "YYYY-MM-DD".
 * @param {string[]} dates
 * @returns {{ validFrom: string|null, validUntil: string|null, days: string|null }}
 */
export function summariseDates(dates) {
  const norm = (d) => String(d || "").replace(/-/g, "");
  const clean = (dates || []).map(norm).filter((d) => /^\d{8}$/.test(d));
  if (clean.length === 0)
    return { validFrom: null, validUntil: null, days: null };

  const sorted = [...clean].sort();
  const validFrom = sorted[0];
  const validUntil = sorted[sorted.length - 1];

  const weekdays = new Set();
  for (const d of sorted) {
    const dt = new Date(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
    );
    weekdays.add(dt.getDay());
  }
  let days;
  if (weekdays.size === 7) {
    days = "Daily";
  } else {
    const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun reads naturally
    days = order
      .filter((d) => weekdays.has(d))
      .map((d) => WEEKDAY_SHORT[d])
      .join(", ");
  }
  return { validFrom, validUntil, days };
}
