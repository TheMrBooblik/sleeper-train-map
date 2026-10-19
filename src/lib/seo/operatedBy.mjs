/**
 * Who runs a set of routes, by name, for page copy. Dependency-free (.mjs):
 * the hub and connection pages call it while rendering, so it must not pull
 * ./data.js (which reads files from disk) into the client bundle.
 */

/**
 * Who runs these routes, by name, for prose: each route's railway companies
 * where the data lists them, else its operators — in first-seen order,
 * without repeats. The Sunrise reads "JR East, JR Central, JR West, JR
 * Shikoku" rather than naming its seller alone.
 * @param {{railways?: string[], operators?: {name: string}[]}[]} routes
 */
export function operatedByNames(routes) {
  const names = [];
  for (const r of routes ?? []) {
    const own = r.railways?.length ? r.railways : (r.operators ?? []).map((o) => o.name);
    for (const n of own) if (n && !names.includes(n)) names.push(n);
  }
  // Where no route lists its railways, keep the order every hub has always
  // printed (operators by name, as uniqueOperators sorts them), so this
  // changes nothing on a page without railway data.
  return (routes ?? []).some((r) => r.railways?.length)
    ? names
    : names.sort((a, b) => a.localeCompare(b));
}
