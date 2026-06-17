/** Canonical production origin, used for canonical URLs, Open Graph and JSON-LD. */
export const SITE_URL = "https://sleeper-train-map.pingwi.com";

/** Default social-share image (1200×630). */
export const OG_IMAGE = `${SITE_URL}/og/og-default.png`;

/** Build an absolute URL from a site-relative path ("/trains/x" → full URL). */
export function absoluteUrl(pathname) {
  if (!pathname) return SITE_URL;
  return `${SITE_URL}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}
