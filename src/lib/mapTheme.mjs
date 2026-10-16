/**
 * The map's colour theme: what the visitor chose, what that resolves to, and
 * how an operator's brand colour survives a dark basemap.
 *
 * Dependency-free `.mjs` so `tests/verify-map-theme.mjs` loads it in raw node,
 * the same reason as `operatorNames.mjs`.
 *
 * The basemap itself is never swapped for another tile service: a dark tile
 * provider is a freemium API with a usage cap (CARTO, Stadia, MapTiler), which
 * is exactly what this project does not depend on. The dark map is the same
 * OpenStreetMap tiles under a CSS filter (`.basemap-tiles` in globals.css), so
 * it costs no request, no key and no attribution change.
 */

export const THEME_STORAGE_KEY = "train-map:mapTheme";

/** "system" follows the OS; the other two are an explicit choice. */
export const THEME_PREFERENCES = ["system", "light", "dark"];

export const DEFAULT_THEME_PREFERENCE = "system";

/** A stored value we do not recognise reads as the default, never as a theme. */
export function parseThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : DEFAULT_THEME_PREFERENCE;
}

/** The theme actually painted: "dark" or "light". */
export function resolveTheme(preference, systemPrefersDark) {
  const pref = parseThemePreference(preference);
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

// ---------------------------------------------------------------------------
// Line colours on a dark basemap
// ---------------------------------------------------------------------------

/**
 * Minimum relative luminance a route line keeps on the dark basemap. The
 * filtered OSM land sits near #1b1e22 (luminance ≈ 0.013), so 0.16 is a
 * contrast of about 3.4:1 — WCAG's figure for graphical objects is 3:1.
 * A third of the brand palette is navy or midnight blue (CFR #003366, MÁV
 * #1B3A6B, Midnight Trains #1A1A2E, SNCF #0C1C8C…), which drawn as-is is
 * a line you cannot see.
 */
export const DARK_MAP_MIN_LUMINANCE = 0.16;

const MAX_LIFTED_LIGHTNESS = 82;

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function toHex(rgb) {
  return `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** WCAG relative luminance of an sRGB triple in 0–1. */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const lin = rgb.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

const liftCache = new Map();

/**
 * The colour a route line is drawn in on the dark basemap: the same hue and
 * saturation, lightened only as far as it takes to clear
 * DARK_MAP_MIN_LUMINANCE. A colour that is already bright enough (ES orange,
 * VIA yellow, ÖBB violet) comes back unchanged, so operators stay
 * recognisable and two routes keep their relative order of lightness.
 * Anything that is not a hex colour ("transparent", rgb()) passes through.
 */
export function liftForDarkMap(color) {
  if (typeof color !== "string") return color;
  const cached = liftCache.get(color);
  if (cached) return cached;
  const rgb = parseHex(color);
  let out = color;
  if (rgb && relativeLuminance(color) < DARK_MAP_MIN_LUMINANCE) {
    const [h, s, l0] = rgbToHsl(rgb);
    let l = l0 * 100;
    let hex = toHex(rgb);
    while (l < MAX_LIFTED_LIGHTNESS) {
      l += 1;
      hex = toHex(hslToRgb([h, s, l / 100]));
      if (relativeLuminance(hex) >= DARK_MAP_MIN_LUMINANCE) break;
    }
    out = hex;
  }
  if (liftCache.size > 512) liftCache.clear();
  liftCache.set(color, out);
  return out;
}
