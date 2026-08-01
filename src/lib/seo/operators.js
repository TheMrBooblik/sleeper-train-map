/**
 * Operator display names and URL slugs for the SEO operator hub pages.
 *
 * The curated table lives in operatorNames.mjs (raw-node importable). Prefer
 * those names for SEO titles. When an agency_id is missing from the table,
 * fall back to the Back-on-Track long name from the committed agencies
 * snapshot (public/data/scraped/backontrack-agencies.json) so a newly added
 * operator never shows as a bare id like "LE".
 *
 * agency_id is frequently compound ("PKP/ČD", "TCDD/BDŽ/CFR") — always run it
 * through splitAgencyIds() before looking an operator up here.
 */

import { slugify } from "./slugify";
import { OPERATORS } from "./operatorNames.mjs";

export { OPERATORS };

// Inverse slug → agency_id map (built once).
const SLUG_TO_ID = new Map(
  Object.entries(OPERATORS).map(([id, meta]) => [meta.slug, id]),
);

/**
 * Split a (possibly compound) agency_id into its component operator ids.
 * "PKP/ČD" → ["PKP", "ČD"]; "ÖBB" → ["ÖBB"].
 * @param {string} agencyId
 * @returns {string[]}
 */
export function splitAgencyIds(agencyId) {
  if (!agencyId) return [];
  return String(agencyId)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve an agency_id to its display metadata, with a graceful fallback so an
 * unknown operator never breaks the build.
 *
 * @param {string} id
 * @param {Record<string, { agency_name?: string, agency_name_romanized?: string }>|undefined} agencies
 *   Optional BoT agencies map. When the curated table has no entry, we prefer
 *   the romanized / official agency_name over the bare id.
 * @returns {{ id: string, name: string, slug: string }}
 */
export function getOperatorMeta(id, agencies) {
  const meta = OPERATORS[id];
  if (meta) return { id, ...meta };
  // No curated entry yet: use the Back-on-Track long name so a newly added
  // operator reads as "Leo Express", not "LE". Slug stays derived from the id
  // so the hub URL is stable even if the operator is renamed upstream.
  const bot = agencies?.[id];
  const name = bot?.agency_name_romanized || bot?.agency_name || id;
  return { id, name, slug: slugify(id) || "operator" };
}

/** Human-readable operator name for an agency_id (falls back to the id). */
export function getOperatorName(id, agencies) {
  return getOperatorMeta(id, agencies).name;
}

/** URL slug for an agency_id. */
export function getOperatorSlug(id) {
  return getOperatorMeta(id).slug;
}

/**
 * Resolve an operator-page slug back to its agency_id.
 * @param {string} slug
 * @returns {string|null}
 */
export function operatorIdFromSlug(slug) {
  return SLUG_TO_ID.get(slug) || null;
}
