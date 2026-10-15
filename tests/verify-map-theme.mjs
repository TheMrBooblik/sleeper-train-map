// tests/verify-map-theme.mjs
// The map's dark theme: the preference a visitor stores, what it resolves to,
// how route colours survive the dark basemap (src/lib/mapTheme.mjs), and the
// wiring that keeps the filter on the basemap alone. Run: npm run verify-map-theme

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DARK_MAP_MIN_LUMINANCE,
  DEFAULT_THEME_PREFERENCE,
  liftForDarkMap,
  parseThemePreference,
  relativeLuminance,
  resolveTheme,
} from "../src/lib/mapTheme.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  ✓ ${name}`);
};

check("an unknown or missing stored value reads as the default, not as a theme", () => {
  assert.equal(DEFAULT_THEME_PREFERENCE, "system");
  for (const v of [null, undefined, "", "Dark", "true", "auto"]) {
    assert.equal(parseThemePreference(v), "system", String(v));
  }
  for (const v of ["system", "light", "dark"]) assert.equal(parseThemePreference(v), v);
});

check("'system' follows the OS; an explicit choice ignores it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("garbage", true), "dark");
});

// Every brand colour, read from the source rather than imported (the module
// is extensionless-import territory for the Next build only).
const brandColors = [
  ...new Set(
    [...read("src/components/Map/utils/operatorColors.js").matchAll(/"(#[0-9A-Fa-f]{6})"/g)].map(
      (m) => m[1],
    ),
  ),
];

check("every operator colour clears the dark-map luminance floor once lifted", () => {
  assert.ok(brandColors.length > 30, `read ${brandColors.length} colours`);
  const failing = brandColors.filter(
    (c) => relativeLuminance(liftForDarkMap(c)) < DARK_MAP_MIN_LUMINANCE,
  );
  assert.deepEqual(failing, []);
});

check("a colour already bright enough is drawn unchanged", () => {
  const bright = brandColors.filter((c) => relativeLuminance(c) >= DARK_MAP_MIN_LUMINANCE);
  assert.ok(bright.length > 5, "the palette has bright brands (ES, VIA, ÖBB…)");
  for (const c of bright) assert.equal(liftForDarkMap(c), c, c);
});

check("the navy brands that vanish on the dark map are the ones that change", () => {
  // CFR, MÁV, Midnight Trains, SNCF: below the floor as published.
  for (const c of ["#003366", "#1B3A6B", "#1A1A2E", "#0C1C8C"]) {
    assert.ok(relativeLuminance(c) < DARK_MAP_MIN_LUMINANCE, c);
    assert.notEqual(liftForDarkMap(c), c, c);
  }
});

check("lifting keeps the hue: a blue stays a blue, a green a green", () => {
  const hueOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const max = Math.max(r, g, b);
    return max === r ? "r" : max === g ? "g" : "b";
  };
  for (const c of brandColors) assert.equal(hueOf(liftForDarkMap(c).toUpperCase()), hueOf(c.toUpperCase()), c);
});

check("anything that is not a hex colour passes through", () => {
  for (const v of ["transparent", "rgba(0,0,0,0.5)", undefined, null, 3]) {
    assert.equal(liftForDarkMap(v), v);
  }
  assert.equal(liftForDarkMap("#000"), liftForDarkMap("#000000"), "short hex is read too");
});

// ─── Wiring ────────────────────────────────────────────────────────────────

const map = read("src/components/Map/DynamicMap.js");
const css = read("src/styles/globals.css");

check("only the OSM basemap carries the filtered class, never the railway overlay", () => {
  const layers = [...map.matchAll(/<TileLayer[\s\S]*?\/>/g)].map((m) => m[0]);
  const osm = layers.find((l) => l.includes("tile.openstreetmap.org"));
  const orm = layers.find((l) => l.includes("openrailwaymap"));
  assert.ok(osm && orm, "both tile layers found");
  assert.match(osm, /className="basemap-tiles"/);
  assert.doesNotMatch(orm, /basemap-tiles/, "track-type colours must stay unfiltered");
});

check("the dark filter is scoped to the theme attribute and the basemap class", () => {
  const filters = [...css.matchAll(/([^{}]+)\{[^}]*\bfilter:\s*invert/g)].map((m) => m[1].trim());
  assert.deepEqual(filters, ['[data-theme="dark"] .basemap-tiles']);
});

check("`dark:` keys on the attribute the map page writes, not on the OS", () => {
  assert.match(css, /@custom-variant dark \(&:where\(\[data-theme="dark"\], \[data-theme="dark"\] \*\)\);/);
  const hook = read("src/hooks/useMapTheme.js");
  assert.match(hook, /root\.dataset\.theme = theme/);
  assert.match(hook, /delete root\.dataset\.theme/, "removed on unmount so other pages never inherit it");
});

check("drawn lines, bar chips and panel chips use the lifted colour on the dark map", () => {
  assert.match(map, /color: isDarkMap\s*\?\s*liftForDarkMap\(path\.pathOptions\.color\)/);
  assert.match(read("src/components/TrainBottomBar/TrainBottomBar.js"), /isDarkMap \? liftForDarkMap\(baseColor\)/);
  assert.match(read("src/components/TrainDetailPanel/TrainDetailPanel.js"), /liftForDarkMap\(getOperatorBaseColor\(trip\)\)/);
});

console.log(`\nverify-map-theme: ${checks} checks passed`);
