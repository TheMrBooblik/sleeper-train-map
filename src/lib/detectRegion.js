// src/lib/detectRegion.js
// Decide whether the visitor is in North America so the map can open centered on
// the NA sleeper network instead of Europe. Client-only, zero-network and
// privacy-friendly: we read the browser's IANA timezone (and fall back to the
// locale region). No IP lookup, no extra request — the map is client-only and
// Leaflet reads the initial center/zoom once at mount, so a synchronous check is
// all we need.

// Default view for North American visitors (roughly the centroid of the
// US/Canada rail network, zoomed to show the continent).
export const NORTH_AMERICA_CENTER = [44, -100];
export const NORTH_AMERICA_ZOOM = 4;

// US, Canada and Mexico IANA timezones. An explicit allowlist (rather than an
// "America/" prefix test) so South/Central America are not misclassified.
// Extend freely — an unknown NA zone just falls through to the Europe default.
const NORTH_AMERICA_TIMEZONES = new Set([
  // United States (contiguous + Alaska/Hawaii)
  "America/New_York",
  "America/Detroit",
  "America/Kentucky/Louisville",
  "America/Kentucky/Monticello",
  "America/Indiana/Indianapolis",
  "America/Indiana/Vincennes",
  "America/Indiana/Winamac",
  "America/Indiana/Marengo",
  "America/Indiana/Petersburg",
  "America/Indiana/Vevay",
  "America/Indiana/Tell_City",
  "America/Indiana/Knox",
  "America/Chicago",
  "America/Menominee",
  "America/North_Dakota/Center",
  "America/North_Dakota/New_Salem",
  "America/North_Dakota/Beulah",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
  // Canada
  "America/St_Johns",
  "America/Halifax",
  "America/Glace_Bay",
  "America/Moncton",
  "America/Goose_Bay",
  "America/Toronto",
  "America/Nipigon",
  "America/Thunder_Bay",
  "America/Iqaluit",
  "America/Pangnirtung",
  "America/Atikokan",
  "America/Winnipeg",
  "America/Rainy_River",
  "America/Resolute",
  "America/Rankin_Inlet",
  "America/Regina",
  "America/Swift_Current",
  "America/Edmonton",
  "America/Cambridge_Bay",
  "America/Yellowknife",
  "America/Inuvik",
  "America/Creston",
  "America/Dawson_Creek",
  "America/Fort_Nelson",
  "America/Vancouver",
  "America/Whitehorse",
  "America/Dawson",
  "America/Montreal",
  // Mexico
  "America/Mexico_City",
  "America/Cancun",
  "America/Merida",
  "America/Monterrey",
  "America/Matamoros",
  "America/Mazatlan",
  "America/Chihuahua",
  "America/Ojinaga",
  "America/Hermosillo",
  "America/Tijuana",
  "America/Bahia_Banderas",
]);

/**
 * @returns {boolean} true when the current browser appears to be in North America.
 * Always false during SSR (no window) so server render stays on the Europe default.
 */
export function isNorthAmericaClient() {
  if (typeof window === "undefined") return false;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && NORTH_AMERICA_TIMEZONES.has(tz)) return true;
    // Locale fallback: en-US, en-CA, fr-CA, es-MX, …
    const langs = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    return langs.some((l) => /-(US|CA|MX)$/i.test(l || ""));
  } catch {
    return false;
  }
}
