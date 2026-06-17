/**
 * One-off generator for the default social-share image (public/og/og-default.png).
 * Renders an SVG → 1200×630 PNG via sharp. Re-run if the branding changes:
 *   node scripts/generate-og-image.mjs
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "og");
const OUT = path.join(OUT_DIR, "og-default.png");

const GREEN = "#5fbb9d";

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0c0f12"/>
      <stop offset="100%" stop-color="#050709"/>
    </linearGradient>
    <linearGradient id="route" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${GREEN}"/>
      <stop offset="100%" stop-color="#7ad1b5"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- moon -->
  <circle cx="1045" cy="135" r="120" fill="url(#glow)"/>
  <circle cx="1045" cy="135" r="58" fill="#e8f5ef"/>
  <circle cx="1072" cy="120" r="52" fill="#0a0d10"/>

  <!-- route line + stations -->
  <path d="M 80 500 C 300 410, 520 545, 770 450 S 1070 395, 1120 460"
        fill="none" stroke="url(#route)" stroke-width="6"
        stroke-linecap="round" stroke-dasharray="1 20"/>
  <circle cx="80" cy="500" r="13" fill="#ffffff"/>
  <circle cx="80" cy="500" r="6" fill="${GREEN}"/>
  <circle cx="770" cy="450" r="9" fill="#ffffff"/>
  <circle cx="1120" cy="460" r="13" fill="#ffffff"/>
  <circle cx="1120" cy="460" r="6" fill="${GREEN}"/>

  <!-- wordmark -->
  <text x="80" y="215" font-family="Helvetica, Arial, sans-serif" font-size="84" font-weight="700" fill="#ffffff" letter-spacing="-2">Sleeper Train Map</text>
  <text x="80" y="290" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="400" fill="#9fb4ae">Explore Europe&#8217;s night &amp; sleeper trains</text>

  <text x="80" y="588" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="${GREEN}" letter-spacing="0">pingwi</text>
  <text x="205" y="588" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="400" fill="#5d6b69">· interactive route map</text>
</svg>`;

await mkdir(OUT_DIR, { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log("Wrote", OUT);
