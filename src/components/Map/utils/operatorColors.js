/**
 * Centralized operator brand colors and route color assignment.
 *
 * Maps each train operator (agency_id) to their brand color.
 * When multiple routes of the same operator are visible,
 * generates distinguishable shades so overlapping routes
 * are easy to tell apart on the map and in the UI.
 */

// ---------------------------------------------------------------------------
// Brand color palette – keyed by agency_id from Back-on-Track data.
// Colors approximate each operator's primary brand identity.
// Easy to extend: just add a new key-value pair.
// ---------------------------------------------------------------------------
export const OPERATOR_BRAND_COLORS = {
  // Central / Eastern Europe
  RJ: "#F0AB00", // RegioJet – golden yellow
  ČD: "#154A8A", // České dráhy – blue
  ZSSK: "#D32F2F", // ZSSK – red
  PKP: "#F47920", // PKP Intercity – orange
  MÁV: "#1B3A6B", // MÁV-START – dark blue
  CFR: "#003366", // CFR Călători – navy blue
  ATC: "#1B6B93", // Astra Trans Carpatic – steel blue
  HŽPP: "#1A3FA0", // HŽ Putnički prijevoz – blue
  LE: "#F08200", // Leo Express – official brand orange (GTFS route_color)

  // Western Europe
  ÖBB: "#B76FCF", // ÖBB – violet
  SNCF: "#0C1C8C", // SNCF Voyageurs – indigo
  FS: "#006C35", // Trenitalia – green
  ES: "#FF3600", // European Sleeper – orange-red
  CS: "#1D3557", // Caledonian Sleeper – midnight blue
  GWR: "#0A493E", // Great Western Railway – dark green

  // Scandinavia
  SJ: "#E3000B", // SJ AB – red
  SJN: "#4A6741", // SJ Nord – muted green
  ST: "#00A3E0", // Snälltåget – cyan
  VY: "#6CBB3C", // Vy – bright green
  GA: "#FF6900", // Go-Ahead Nordic – orange
  VR: "#00853F", // VR (Finland) – green

  // Southeast Europe / Balkans
  BDŽ: "#0066B3", // BDŽ – blue
  ŽPCG: "#1E3A5F", // Montenegro Railways – dark blue
  ŽS: "#1B2A49", // Serbian Railways – dark navy

  // Other
  TCDD: "#C8102E", // TCDD – red
  UZ: "#005BAC", // Ukrzaliznytsia – blue
  CFM: "#2E5AA7", // Calea Ferată din Moldova – blue
  RDC: "#8B0000", // RDC / BahnTouristikExpress – dark red
  MT: "#1A1A2E", // Midnight Trains – dark navy
  OTE: "#4CAF50", // Optima Tours – green
  UEX: "#E53935", // Urlaubs-Express – red

  // China
  CR: "#C8102E", // China Railway – China red

  // Japan
  JRW: "#0072BC", // JR West – JR West blue

  // Thailand
  SRT: "#E36B1E", // State Railway of Thailand – SRT orange

  // Malaysia
  KTMB: "#1D4F91", // KTM Berhad (Keretapi Tanah Melayu) – KTM blue

  // Vietnam
  VNR: "#0E7C3A", // Vietnam Railways (Đường sắt Việt Nam) – VNR green

  // Caucasus
  GR: "#D4380D", // Georgian Railway – Georgian red-orange
  ADY: "#0080C8", // ADY (Azerbaijan Railways) – ADY blue
  SCR: "#7B2D8B", // South Caucasus Railway (Armenia) – violet

  // North America
  AMTK: "#003E7A", // Amtrak – Amtrak blue
  VIA: "#FFC72C", // VIA Rail Canada – VIA yellow
};

// Optional secondary accent colors for operators with many routes.
// This keeps dense operator groups easier to distinguish.
const OPERATOR_SECONDARY_COLORS = {
  ÖBB: "#C000A2", // Additional ÖBB tone requested by user
};

// Neutral gray for operators without a known brand color
export const NEUTRAL_FALLBACK_COLOR = "#6B7280";

// ---------------------------------------------------------------------------
// Color helpers (internal)
// ---------------------------------------------------------------------------

/** Convert hex (#RRGGBB) → [h 0-360, s 0-100, l 0-100]. */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return [h * 360, s * 100, l * 100];
}

/** Convert [h 0-360, s 0-100, l 0-100] → hex (#RRGGBB). */
function hslToHex(h, s, l) {
  h /= 360;
  s /= 100;
  l /= 100;

  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const f = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = f(p, q, h + 1 / 3);
    g = f(p, q, h);
    b = f(p, q, h - 1 / 3);
  }

  const toHex = (x) => {
    const v = Math.round(x * 255).toString(16);
    return v.length === 1 ? "0" + v : v;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the base brand color for an operator from a route or trip object.
 * Falls back to NEUTRAL_FALLBACK_COLOR when agency_id is missing or unknown.
 */
export function getOperatorBaseColor(routeOrTrip) {
  const agencyId = (routeOrTrip?.agency_id || "").trim();
  return OPERATOR_BRAND_COLORS[agencyId] || NEUTRAL_FALLBACK_COLOR;
}

/**
 * Generate a shade of baseHex for `index` out of `count` items.
 * Returns the base color unchanged when count <= 1.
 * Otherwise adjusts lightness evenly around the base value.
 */
export function generateShade(baseHex, index, count) {
  if (count <= 1) return baseHex;

  const [h, s, l] = hexToHsl(baseHex);

  // Spread across up to ±15% lightness, scaling with count
  const totalSpread = Math.min(count * 6, 30);
  const step = totalSpread / Math.max(count - 1, 1);
  const offset = -totalSpread / 2 + index * step;
  const newL = Math.max(20, Math.min(80, l + offset));

  return hslToHex(h, s, newL);
}

/**
 * Build a Map<routeId, hexColor> for the given routes.
 * Routes of the same operator are assigned shaded variants when there are 2+.
 *
 * @param {string[]} routesToShow - route ID strings
 * @param {Map<string, Object>} routeMap - routeId → route object (needs agency_id)
 * @returns {Map<string, string>} routeId → hex color
 */
export function buildRouteColorMap(routesToShow, routeMap) {
  // Group routes by operator for shade assignment
  const operatorGroups = new Map();
  routesToShow.forEach((routeId) => {
    const route = routeMap.get(routeId);
    const agencyId = (route?.agency_id || "").trim() || "_unknown_";
    if (!operatorGroups.has(agencyId)) {
      operatorGroups.set(agencyId, []);
    }
    operatorGroups.get(agencyId).push(routeId);
  });

  // Sort each group by numeric routeId for stable shade ordering
  operatorGroups.forEach((routeIds) => {
    routeIds.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  });

  // Assign colors: base brand color with shade variation within each group
  const colorMap = new Map();
  operatorGroups.forEach((routeIds, agencyId) => {
    const baseColor = OPERATOR_BRAND_COLORS[agencyId] || NEUTRAL_FALLBACK_COLOR;
    const secondaryColor = OPERATOR_SECONDARY_COLORS[agencyId];

    // If an operator has many routes and a secondary color,
    // split into two stable halves for better visual separation.
    if (secondaryColor && routeIds.length >= 6) {
      const splitIndex = Math.ceil(routeIds.length / 2);
      const firstHalf = routeIds.slice(0, splitIndex);
      const secondHalf = routeIds.slice(splitIndex);

      firstHalf.forEach((routeId, index) => {
        colorMap.set(
          routeId,
          generateShade(baseColor, index, firstHalf.length),
        );
      });
      secondHalf.forEach((routeId, index) => {
        colorMap.set(
          routeId,
          generateShade(secondaryColor, index, secondHalf.length),
        );
      });
      return;
    }

    routeIds.forEach((routeId, index) => {
      colorMap.set(routeId, generateShade(baseColor, index, routeIds.length));
    });
  });

  return colorMap;
}

/**
 * Convert a hex color to an rgba() CSS string with the given alpha.
 * Useful for tinted backgrounds (e.g. operator-colored badges).
 */
export function hexWithAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
