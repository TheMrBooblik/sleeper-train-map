/**
 * Canonical production origin, used for canonical URLs, Open Graph and JSON-LD.
 *
 * The site moved here from sleeper-train-map.pingwi.com. That host stays attached
 * to the same Vercel project and 301s here via next.config.js — do NOT configure a
 * Vercel domain-level redirect for it, which would preserve the path and turn every
 * retired /trains/ URL into a two-hop chain.
 *
 * This is the ONLY place the origin is written. Everything else builds URLs through
 * absoluteUrl() so a future move is a one-line change.
 */
export const SITE_URL = "https://pingwi.com";

/** The old host, kept for the redirect rule in next.config.js. */
export const LEGACY_HOST = "sleeper-train-map.pingwi.com";

/** Default social-share image (1200×630). */
export const OG_IMAGE = `${SITE_URL}/og/og-default.png`;

/** Build an absolute URL from a site-relative path ("/connections/x" → full URL). */
export function absoluteUrl(pathname) {
  if (!pathname) return SITE_URL;
  return `${SITE_URL}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}
