// scripts/lib/price-extract.mjs
// Defensive price extraction from arbitrary booking-API JSON. Upstream
// response shapes shift without notice; rather than chase exact schemas we
// walk the object for plausible price fields and take the minimum. Output is
// only ever a review-queue proposal, so a wrong pick is caught by the admin.
//
// The walk is shared with the debug script (scripts/probe-prices-debug.mjs) on
// purpose. "No price field found" is the probe's most common outcome and the
// hardest to act on, so the diagnostic has to report what the extractor
// actually saw — a second, hand-written walk would drift from this one and
// send whoever is debugging after the wrong shape.

const PRICE_KEY = /price|amount|fare/i;
const EXCLUDE_KEY = /id|code|date|time|number|count|distance|duration/i;

/**
 * Every number the extractor considers a plausible price, with the JSON path it
 * was found at. Ordered as encountered.
 *
 * @param {unknown} value
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {Array<{path: string, key: string, value: number, raw: unknown}>}
 */
export function collectPriceCandidates(value, { min = 5, max = 2000 } = {}) {
  const found = [];
  const visit = (node, keyHint, path) => {
    if (node == null) return;
    const plausibleKey = keyHint && PRICE_KEY.test(keyHint) && !EXCLUDE_KEY.test(keyHint);

    if (typeof node === "number") {
      if (plausibleKey && node >= min && node <= max) {
        found.push({ path, key: keyHint, value: node, raw: node });
      }
      return;
    }
    if (typeof node === "string") {
      // "49,90 €" / "from €49.90"
      if (plausibleKey) {
        const m = node.replace(",", ".").match(/(\d+(?:\.\d{1,2})?)/);
        if (m) {
          const parsed = Number(m[1]);
          if (parsed >= min && parsed <= max) {
            found.push({ path, key: keyHint, value: parsed, raw: node });
          }
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, keyHint, `${path}[${i}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        visit(child, key, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(value, null, "");
  return found;
}

/**
 * The cheapest plausible price in an arbitrary response, or null when the walk
 * found nothing that looks like one.
 *
 * @param {unknown} value
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {number|null}
 */
export function extractMinPrice(value, bounds = {}) {
  const candidates = collectPriceCandidates(value, bounds);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.value < best ? c.value : best), Infinity);
}
