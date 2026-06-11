// scripts/lib/price-extract.mjs
// Defensive price extraction from arbitrary booking-API JSON. Upstream
// response shapes shift without notice; rather than chase exact schemas we
// walk the object for plausible price fields and take the minimum. Output is
// only ever a review-queue proposal, so a wrong pick is caught by the admin.

const PRICE_KEY = /price|amount|fare/i;
const EXCLUDE_KEY = /id|code|date|time|number|count|distance|duration/i;

export function extractMinPrice(value, { min = 5, max = 2000 } = {}) {
  let best = null;
  const visit = (node, keyHint) => {
    if (node == null) return;
    if (typeof node === "number") {
      if (
        keyHint &&
        PRICE_KEY.test(keyHint) &&
        !EXCLUDE_KEY.test(keyHint) &&
        node >= min &&
        node <= max
      ) {
        if (best === null || node < best) best = node;
      }
      return;
    }
    if (typeof node === "string") {
      // "49,90 €" / "from €49.90"
      if (keyHint && PRICE_KEY.test(keyHint) && !EXCLUDE_KEY.test(keyHint)) {
        const m = node.replace(",", ".").match(/(\d+(?:\.\d{1,2})?)/);
        if (m) {
          const parsed = Number(m[1]);
          if (parsed >= min && parsed <= max && (best === null || parsed < best)) {
            best = parsed;
          }
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, keyHint));
      return;
    }
    if (typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        visit(child, key);
      }
    }
  };
  visit(value, null);
  return best;
}
