/**
 * Human-readable frequency overrides for specific routes.
 * Used when trip.service_id is a date range; we show official operating periods instead.
 * Source: operator websites (e.g. Snälltåget Austria).
 */

// Snälltåget Malmö – Austria (Zell am See / Innsbruck)
// Route ID 73 in Back-on-Track data (Malmö C ↔ Innsbruck Hbf)
// Source: https://www.snalltaget.se/en/austria
export const SNALLTAGET_AUSTRIA_FREQUENCY = {
  routeId: 73,
  label: "Seasonal (Snälltåget to the Alps)",
  periods: [
    { season: "Summer", dates: "3 July – 2 August 2026" },
    { season: "Winter", dates: "18 Dec. 2026 – 14 March 2027" },
  ],
  sourceUrl: "https://www.snalltaget.se/en/austria",
};

/**
 * Get human-readable frequency for a route/trip if we have an override.
 * @param {string|number} routeId - Route ID
 * @returns {{ text: string, sourceUrl?: string }|null} Formatted frequency or null if no override
 */
export function getRouteFrequencyOverride(routeId) {
  const id = routeId?.toString();
  if (id === "73") {
    const { label, periods, sourceUrl } = SNALLTAGET_AUSTRIA_FREQUENCY;
    const periodLines = periods
      .map((p) => `${p.season}: ${p.dates}`)
      .join("; ");
    return {
      text: `${periodLines}`,
      sourceUrl,
    };
  }
  return null;
}
