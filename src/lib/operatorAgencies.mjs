/**
 * Multi-operator resolution for jointly-operated routes.
 *
 * Back-on-Track encodes joint operation as compound agency ids ("PKP/ČD",
 * "RDC/SJ", "TCDD/BDŽ/CFR"). Each component is a real agency in the BoT
 * agencies dataset (logo, homepage, sometimes a booking portal), and each may
 * also have a curated entry in data/overrides/operator-booking.json.
 *
 * This module splits a compound id into its components and resolves, per
 * component, the best link we can offer ("does this operator sell this
 * ticket?"): origin/dest deep link → curated booking page → BoT booking
 * portal (agency_fare_url) → operator homepage. The same tiering picks the
 * main booking CTA across components in resolveBookingHref().
 *
 * .mjs so the raw-node verify suite (tests/verify-operator-agencies.mjs) can
 * import it, same as naBooking.mjs.
 */
import {
  buildBookingUrl,
  getBookingPageUrl,
  getDealsLink,
} from "./operatorBooking.js";

/** "PKP/ČD" → ["PKP", "ČD"]; trims whitespace, drops empty segments. */
export function splitAgencyIds(agencyId) {
  return (agencyId || "")
    .split("/")
    .map((id) => id.trim())
    .filter(Boolean);
}

const LINK_TIERS = ["deepLink", "bookingPageUrl", "fareUrl", "homeUrl"];
const LINK_KINDS = { deepLink: "deep", bookingPageUrl: "page", fareUrl: "fare", homeUrl: "home" };

/**
 * Resolve each component operator of a (possibly compound) agency id.
 *
 * `agencies` is the BoT agencies map (agency_id → agency record) from
 * useAgencies(); it may be empty/undefined while still loading. Ids missing
 * from it (SCR, GR, CR, AMTK, VIA…) degrade gracefully: no logo, but any
 * curated booking config still applies.
 *
 * Returns [{ id, name, logoUrl, deepLink, bookingPageUrl, fareUrl, homeUrl,
 * linkUrl, linkKind }] in the id's original order.
 */
export function resolveOperatorComponents({ agencyId, agencies, origin, dest }) {
  return splitAgencyIds(agencyId).map((id) => {
    const agency = agencies?.[id] || null;
    const component = {
      id,
      name: agency?.agency_name || id,
      logoUrl: agency?.agency_logo_url || null,
      deepLink: buildBookingUrl({ agencyId: id, origin, dest }),
      bookingPageUrl: getBookingPageUrl(id),
      fareUrl: agency?.agency_fare_url || null,
      homeUrl: agency?.agency_url || null,
      linkUrl: null,
      linkKind: null,
    };
    for (const tier of LINK_TIERS) {
      if (component[tier]) {
        component.linkUrl = component[tier];
        component.linkKind = LINK_KINDS[tier];
        break;
      }
    }
    return component;
  });
}

/**
 * Pick the main booking CTA across all components, tiered by link quality so
 * the operator with the best booking experience wins (e.g. for "UZ/ÖBB" the
 * ÖBB deep link beats UZ's booking portal). Falls back to the caller-supplied
 * agencyUrl (BoT homepage of the whole id) when no component has anything.
 *
 * Returns { href, deepLink, componentId, componentName, dealsLink }.
 */
export function resolveBookingHref({ agencyId, agencies, agencyUrl, origin, dest }) {
  const components = resolveOperatorComponents({ agencyId, agencies, origin, dest });
  for (const tier of LINK_TIERS) {
    const winner = components.find((c) => c[tier]);
    if (winner) {
      return {
        href: winner[tier],
        deepLink: tier === "deepLink" ? winner.deepLink : null,
        componentId: winner.id,
        componentName: winner.name,
        dealsLink: getDealsLink(winner.id),
      };
    }
  }
  return {
    href: agencyUrl || null,
    deepLink: null,
    componentId: null,
    componentName: null,
    dealsLink: getDealsLink(agencyId),
  };
}
