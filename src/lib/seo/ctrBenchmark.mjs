/**
 * What a page at a given position ought to earn, and therefore how many of its
 * clicks are actually winnable.
 *
 * This exists to keep the snippet readout honest about WHICH pages a title can
 * move. `/connections/aurillac-to-paris` takes 660 impressions at position 65
 * and no clicks; no wording rescues it, and letting it into a CTR average
 * dilutes a real change with impressions nothing could have won. The report
 * uses this to band pages, and the same numbers sized the experiment that was
 * considered and dropped (see CLAUDE.md).
 *
 * Dependency-free `.mjs`, so the report script and the verify suite read the
 * same curve the site was measured against.
 */

/** Blended organic click-through rate for positions 1-10. */
const CTR_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.033, 0.03, 0.025];

/**
 * Expected CTR at a position, as a fraction.
 * @param {number} position
 * @returns {number}
 */
export function benchmarkCtr(position) {
  const p = Math.round(Number(position) || 0);
  if (p >= 1 && p <= 10) return CTR_BY_POSITION[p - 1];
  if (p <= 15) return 0.015;
  if (p <= 20) return 0.01;
  if (p <= 30) return 0.005;
  if (p <= 50) return 0.002;
  return 0.0005;
}

/**
 * Clicks a page would earn at benchmark CTR — how much is on the table there.
 * @param {{impressions?: number, position?: number}} page
 * @returns {number}
 */
export function winnableClicks({ impressions = 0, position = 0 } = {}) {
  return Number(impressions) * benchmarkCtr(position);
}
