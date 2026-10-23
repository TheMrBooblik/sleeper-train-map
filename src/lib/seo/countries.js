/**
 * Country metadata for the SEO country-hub pages.
 *
 * Extends the shared map country list (src/lib/countries.js) with the United
 * Kingdom (Caledonian Sleeper / GWR night trains run there but GB is absent from
 * the map's region list) and adds code normalization + slug lookups.
 */

import { COUNTRIES } from "../countries.js";
import { slugify } from "./slugify.mjs";
import { normalizeCountryCode } from "../countryCode.mjs";

// United Kingdom is not in the map's region list but has real night-train content.
const SEO_ONLY_COUNTRIES = [
  { code: "GB", name: "United Kingdom", center: [54.5, -3.5], zoom: 5 },
];

/** All countries eligible for a hub page: the 24 map regions + GB. */
export const SEO_COUNTRIES = [...COUNTRIES, ...SEO_ONLY_COUNTRIES];

// code → { code, name, slug, ... }
const BY_CODE = new Map();
const BY_SLUG = new Map();
for (const c of SEO_COUNTRIES) {
  const entry = { ...c, slug: slugify(c.name) };
  BY_CODE.set(c.code, entry);
  BY_SLUG.set(entry.slug, entry);
}

// Defined in a dependency-free .mjs rather than here, because the plan-index
// build runs in raw node. Imported as well as re-exported: this file calls it
// itself (getSeoCountry, countrySlug), and `export … from` creates no local
// binding — which failed the build rather than anything subtler.
export { normalizeCountryCode };

/** Country metadata by (normalized) code, or null if not a hub country. */
export function getSeoCountry(code) {
  return BY_CODE.get(normalizeCountryCode(code)) || null;
}

/** Country metadata by slug, or null. */
export function getSeoCountryBySlug(slug) {
  return BY_SLUG.get(slug) || null;
}

/** Slug for a (normalized) country code, or "" if not a hub country. */
export function countrySlug(code) {
  const entry = getSeoCountry(code);
  return entry ? entry.slug : "";
}

/**
 * Fallback country codes for synthetic operators whose stations are absent from
 * the Back-on-Track stop index (so stop_country lookups would miss them).
 * Only codes present in SEO_COUNTRIES ultimately surface as hubs.
 * @type {Record<string, string[]>}
 */
export const OPERATOR_COUNTRY_FALLBACK = {
  CR: ["CN"], // China Railway
  JRW: ["JP"], // JR West (Sunrise Izumo / Seto)
  SRT: ["TH"], // State Railway of Thailand
  KTMB: ["MY"], // KTM Berhad (Malaysia)
  VNR: ["VN"], // Vietnam Railways
  GR: ["GE"], // Georgian Railway (no GE hub — informational only)
  ADY: ["AZ"], // Azerbaijan Railways
  SCR: ["AM"], // South Caucasus Railway (Armenia)
  AMTK: ["US"], // Amtrak
  VIA: ["CA"], // VIA Rail Canada
};
