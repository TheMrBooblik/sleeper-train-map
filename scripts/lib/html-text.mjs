// scripts/lib/html-text.mjs
// Strip an HTML document down to readable text for AI extraction prompts.
// Same approach as the railway.ge scraper: drop script/style, untag, decode
// the handful of entities that matter, collapse whitespace.

export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&#8211;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&euro;/g, "€")
    .replace(/&#8364;/g, "€")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}
