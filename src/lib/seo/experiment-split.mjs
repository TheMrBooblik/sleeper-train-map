/**
 * The rule that split the connection pages into the two arms of the snippet
 * experiment, as a pure function over the stored baseline.
 *
 * It lives apart from `experiment.mjs` because that module imports the
 * committed assignment, and this rule has to run when the assignment does not
 * exist yet — `build-snippet-experiment.mjs` uses it to create the file, and
 * `verify-seo-snippets` uses it to re-derive the split from the baseline inside
 * that same file and fail if the two have come apart.
 */

export const TREATMENT_GROUP = "treatment";
export const CONTROL_GROUP = "control";

/**
 * Blended organic click-through rate by position.
 *
 * Used only to rank pages by how many clicks are actually winnable on them, so
 * the two arms are matched on that rather than on raw impressions: a page at
 * position 65 with 660 impressions and no clicks (aurillac-to-paris) cannot be
 * rescued by a title and must not be allowed to balance a page at position 8.
 */
const CTR_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.033, 0.03, 0.025];

/** @param {number} position @returns {number} */
export function benchmarkCtr(position) {
  const p = Math.round(Number(position) || 0);
  if (p >= 1 && p <= 10) return CTR_BY_POSITION[p - 1];
  if (p <= 15) return 0.015;
  if (p <= 20) return 0.01;
  if (p <= 30) return 0.005;
  if (p <= 50) return 0.002;
  return 0.0005;
}

/** Clicks a page would earn at benchmark CTR — the ranking key for the split. */
export function winnableClicks({ impressions = 0, position = 0 } = {}) {
  return Number(impressions) * benchmarkCtr(position);
}

/**
 * Split pages into the two arms.
 *
 * Rank by winnable clicks, then walk the ranking two at a time and give each
 * adjacent pair one page to each arm. Taking adjacent ranks keeps the arms
 * matched on position and on how much is winnable; choosing WHICH of the two
 * goes where by whichever arm is currently behind keeps them matched on volume
 * as well, which a plain alternation does not.
 *
 * Measured against the real baseline, this is better on every axis than the two
 * alternatives that were tried:
 *
 *   matched pairs, balanced   6 102 / 6 102 impressions, 19 / 11 clicks, winnable 62.6 / 67.0
 *   plain alternation         6 504 / 5 700 impressions,  9 / 21 clicks, winnable 68.2 / 61.3
 *   greedy on clicks alone    7 159 / 5 221 impressions, 15 / 15 clicks
 *
 * The residual click gap is one page: vienna-to-zurich carries 8 of the 30
 * baseline clicks in the whole set, so no split can halve them. That is what
 * the stored baseline and the difference-in-differences readout are for.
 *
 * Ties break on the slug, so the split is reproducible from the file alone.
 *
 * @param {Record<string, {impressions?: number, clicks?: number, position?: number}>} baseline
 * @returns {Map<string, string>} slug → TREATMENT_GROUP | CONTROL_GROUP
 */
export function assignGroups(baseline) {
  const pages = baseline || {};
  const ranked = Object.keys(pages).sort((a, b) => {
    const diff = winnableClicks(pages[b]) - winnableClicks(pages[a]);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const groups = new Map();
  const running = {
    [TREATMENT_GROUP]: { impressions: 0, clicks: 0 },
    [CONTROL_GROUP]: { impressions: 0, clicks: 0 },
  };
  const take = (slug, group) => {
    groups.set(slug, group);
    running[group].impressions += Number(pages[slug].impressions || 0);
    running[group].clicks += Number(pages[slug].clicks || 0);
  };
  /** Which arm is behind on volume, so the heavier page of the pair goes there. */
  const behind = () => {
    const t = running[TREATMENT_GROUP];
    const c = running[CONTROL_GROUP];
    if (t.impressions !== c.impressions) return t.impressions < c.impressions ? TREATMENT_GROUP : CONTROL_GROUP;
    return t.clicks <= c.clicks ? TREATMENT_GROUP : CONTROL_GROUP;
  };

  for (let i = 0; i < ranked.length; i += 2) {
    const [first, second] = ranked.slice(i, i + 2);
    const heavyArm = behind();
    if (second === undefined) {
      take(first, heavyArm);
      continue;
    }
    const lightArm = heavyArm === TREATMENT_GROUP ? CONTROL_GROUP : TREATMENT_GROUP;
    const byVolume = (pages[first].impressions || 0) >= (pages[second].impressions || 0);
    take(byVolume ? first : second, heavyArm);
    take(byVolume ? second : first, lightArm);
  }
  return groups;
}
