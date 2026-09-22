/**
 * Which snippet variant a connection page renders.
 *
 * The pair pages are running one experiment: half render the fact-bearing
 * snippet from `snippet.mjs`, half render the template they always had. The
 * split is COMMITTED rather than derived at build time, because a membership
 * that moves with the data cannot be compared against itself six weeks later —
 * and the same file carries each page's pre-experiment Search Console numbers,
 * which is the part that cannot be recovered afterwards.
 *
 * The baseline is what makes the readout honest. The site's own average
 * position moved from 50.8 to 17.3 in the five weeks before this started, so a
 * before/after on the treatment arm alone would be measuring that trend; the
 * control arm and the stored baseline turn it into a difference-in-differences.
 *
 * The rule that produced the split lives in `experiment-split.mjs`, which has
 * to run before this file's artifact exists.
 */
import EXPERIMENT from "../../../data/seo/snippet-experiment.json" with { type: "json" };

import { CONTROL, FACTS } from "./snippet.mjs";
import { TREATMENT_GROUP } from "./experiment-split.mjs";

/** The committed experiment, for the report script and the tests. */
export function getExperiment() {
  return EXPERIMENT;
}

/**
 * The snippet variant a pair page renders.
 *
 * Anything the committed file does not name renders the control, so a pair
 * published after the split was frozen can never be silently enrolled — it
 * would have no baseline to be measured against.
 *
 * @param {string} slug
 * @returns {string} CONTROL | FACTS
 */
export function variantFor(slug) {
  return EXPERIMENT.pages?.[slug]?.group === TREATMENT_GROUP ? FACTS : CONTROL;
}
