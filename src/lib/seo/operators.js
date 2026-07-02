/**
 * Operator display names and URL slugs for the SEO operator hub pages.
 *
 * agency_name is not committed to the repo (it is fetched live from Back-on-Track),
 * so this curated table is the build-time source of truth. It is seeded from the
 * human-readable comments in src/components/Map/utils/operatorColors.js (the canonical
 * agency_id set) plus registry labels. Names are chosen to read well in SEO titles
 * such as "{name} Night Train Routes & Destinations".
 *
 * agency_id is frequently compound ("PKP/ČD", "TCDD/BDŽ/CFR") — always run it through
 * splitAgencyIds() before looking an operator up here.
 */

import { slugify } from "./slugify";

/** @type {Record<string, { name: string, slug: string }>} */
export const OPERATORS = {
  // Central / Eastern Europe
  RJ: { name: "RegioJet", slug: "regiojet" },
  "ČD": { name: "Czech Railways", slug: "czech-railways" },
  ZSSK: { name: "ZSSK", slug: "zssk" },
  PKP: { name: "PKP Intercity", slug: "pkp-intercity" },
  "MÁV": { name: "MÁV-START", slug: "mav-start" },
  CFR: { name: "CFR Călători", slug: "cfr-calatori" },
  ATC: { name: "Astra Trans Carpatic", slug: "astra-trans-carpatic" },
  "HŽPP": { name: "Croatian Railways", slug: "croatian-railways" },

  // Western Europe
  "ÖBB": { name: "Nightjet", slug: "nightjet" },
  SNCF: { name: "SNCF", slug: "sncf" },
  FS: { name: "Trenitalia", slug: "trenitalia" },
  ES: { name: "European Sleeper", slug: "european-sleeper" },
  CS: { name: "Caledonian Sleeper", slug: "caledonian-sleeper" },
  GWR: { name: "Great Western Railway", slug: "great-western-railway" },
  MT: { name: "Midnight Trains", slug: "midnight-trains" },

  // Scandinavia
  SJ: { name: "SJ", slug: "sj" },
  SJN: { name: "SJ Nord", slug: "sj-nord" },
  ST: { name: "Snälltåget", slug: "snalltaget" },
  VY: { name: "Vy", slug: "vy" },
  GA: { name: "Go-Ahead Nordic", slug: "go-ahead-nordic" },
  VR: { name: "VR", slug: "vr" },
  RDC: { name: "RDC / BahnTouristikExpress", slug: "rdc" },

  // Southeast Europe / Balkans
  "BDŽ": { name: "Bulgarian Railways", slug: "bulgarian-railways" },
  "ŽPCG": { name: "Montenegro Railways", slug: "montenegro-railways" },
  "ŽS": { name: "Serbian Railways", slug: "serbian-railways" },

  // Other
  TCDD: { name: "Turkish State Railways", slug: "tcdd" },
  UZ: { name: "Ukrainian Railways", slug: "ukrainian-railways" },
  CFM: { name: "Moldovan Railways", slug: "moldovan-railways" },
  OTE: { name: "Optima Tours", slug: "optima-tours" },
  UEX: { name: "Urlaubs-Express", slug: "urlaubs-express" },

  // China
  CR: { name: "China Railway", slug: "china-railway" },

  // Caucasus
  GR: { name: "Georgian Railway", slug: "georgian-railway" },
  ADY: { name: "Azerbaijan Railways", slug: "azerbaijan-railways" },
  SCR: { name: "South Caucasus Railway", slug: "south-caucasus-railway" },

  // North America
  AMTK: { name: "Amtrak", slug: "amtrak" },
  VIA: { name: "VIA Rail", slug: "via-rail" },
};

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
 * @param {string} id
 * @returns {{ id: string, name: string, slug: string }}
 */
export function getOperatorMeta(id) {
  const meta = OPERATORS[id];
  if (meta) return { id, ...meta };
  return { id, name: id, slug: slugify(id) || "operator" };
}

/** Human-readable operator name for an agency_id (falls back to the id). */
export function getOperatorName(id) {
  return getOperatorMeta(id).name;
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
