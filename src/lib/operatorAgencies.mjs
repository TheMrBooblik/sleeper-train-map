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
  buildScheduleCandidate,
  getBookingPageUrl,
  getOperatorBooking,
  getDealsLink,
  getScheduleLabel,
  isAffiliateSchedule,
  SCHEDULE_TIERS,
} from "./operatorBooking.js";
import { OPERATORS, splitAgencyIds } from "./seo/operatorNames.mjs";

/** "PKP/ČD" → ["PKP", "ČD"]; trims whitespace, drops empty segments. */
export { splitAgencyIds } from "./seo/operatorNames.mjs";

/**
 * A train number as the operator writes it.
 *
 * Most feeds already carry the operator's own prefix ("NJ 421", "EN 40459",
 * "ICN 752"), but some publish a bare number because that is what
 * Back-on-Track's trip_short_name holds — European Sleeper's ES 400 arrives
 * simply as "400", which is not how the operator, its tickets or its website
 * name the train. Operators that need one declare a `numberPrefix` in the
 * curated table (src/lib/seo/operatorNames.mjs); everyone else is untouched,
 * which is why this never turns "NJ 421" into "ÖBB NJ 421".
 *
 * Display only. Never feed the result back into a lookup — the feeds, the
 * review queue and the enrichment are all keyed by the raw value.
 *
 * @param {string} trainNumber  raw trip_short_name, e.g. "400" or "NJ 421"
 * @param {string} agencyId     possibly compound, e.g. "ES" or "PKP/ČD"
 * @returns {string}
 */
export function formatTrainNumber(trainNumber, agencyId) {
  const raw = String(trainNumber ?? "").trim();
  // Anything already carrying letters is the operator's own label — leave it.
  if (!raw || !/^\d+$/.test(raw)) return raw;
  for (const id of splitAgencyIds(agencyId)) {
    const prefix = OPERATORS[id]?.numberPrefix;
    if (prefix) return `${prefix} ${raw}`;
  }
  return raw;
}

// Route page first: where an operator publishes a page for this exact corridor
// it beats a prefilled search, because it is the page they sell the route on.
// `routePages` is the same key naBooking.mjs reads for Amtrak/VIA — those go
// through their own builder, so the two never resolve the same row twice.
const LINK_TIERS = ["routePage", "deepLink", "bookingPageUrl", "fareUrl", "homeUrl"];
const LINK_KINDS = {
  routePage: "route",
  deepLink: "deep",
  bookingPageUrl: "page",
  fareUrl: "fare",
  homeUrl: "home",
};

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
export function resolveOperatorComponents({ agencyId, agencies, origin, dest, routeId }) {
  return splitAgencyIds(agencyId).map((id) => {
    const agency = agencies?.[id] || null;
    const booking = getOperatorBooking(id);
    const component = {
      id,
      name: agency?.agency_name || id,
      logoUrl: agency?.agency_logo_url || null,
      routePage: routeId ? (booking?.routePages?.[String(routeId)] ?? null) : null,
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
export function resolveBookingHref({ agencyId, agencies, agencyUrl, origin, dest, routeId }) {
  const components = resolveOperatorComponents({ agencyId, agencies, origin, dest, routeId });
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

/**
 * The leg of a compound train label that belongs to one component operator, or
 * null when the data cannot say.
 *
 * Back-on-Track writes a jointly-operated train as one label per leg
 * ("PKP/ČD" running "EN 443 / IC 406"), and it is tempting to pair the nth leg
 * with the nth operator. That is wrong: the legs run in travel order while the
 * agency id does not follow it. Under the same "PKP/ČD" id, route 9 (Praha →
 * Warszawa) writes ČD's EN 443 first, while route 265 writes PKP's TLK 403
 * first — so pairing by position links one of them to the other operator's
 * train, which is a real page for the wrong service.
 *
 * Nothing else in the row distinguishes them, so a compound label under a
 * compound id yields no per-train link at all and the caller falls back to a
 * tier that needs no number. A compound label under a *single* operator is a
 * different thing — through cars of one journey ("CFR" running
 * "IRN 1954/R 8824") — and keeps linking to its first leg.
 *
 * @returns {string|null} the label to resolve a number from, or null if unknowable
 */
export function trainLegForOperator(trainLabel, agencyId) {
  const label = String(trainLabel ?? "");
  if (splitAgencyIds(agencyId).length <= 1) return label;
  return label.includes("/") ? null : label;
}

/**
 * The best "official timetable" link across the components of a (possibly
 * compound) agency id.
 *
 * Booking tiers by *link quality* — which operator sells the ticket. Schedule
 * tiers by *specificity* instead: for "CFM/CFR" a per-train CFR page beats
 * CFM's homepage-level timetable, because the question a reader is asking is
 * "where do I check this train's times", not "who sells it". A component with
 * no schedule config contributes nothing rather than falling back.
 *
 * Returns { url, label, operatorId, operatorName, tier, affiliate } or null.
 */
export function resolveScheduleLink({
  agencyId,
  agencies,
  train,
  routeId,
  countryCode,
  originCountry,
  destCountry,
  originCode,
  date,
}) {
  const candidates = [];
  for (const id of splitAgencyIds(agencyId)) {
    // Each component resolves against its own leg of a joint train's label.
    const leg = trainLegForOperator(train, agencyId);
    const candidate = buildScheduleCandidate({
      agencyId: id,
      train: leg,
      routeId,
      countryCode,
      originCountry,
      destCountry,
      originCode,
      date,
    });
    if (candidate?.url) candidates.push({ ...candidate, id });
  }
  if (candidates.length === 0) return null;

  for (const tier of SCHEDULE_TIERS) {
    const winner = candidates.find((c) => c.tier === tier);
    if (!winner) continue;
    return {
      url: winner.url,
      label: getScheduleLabel(winner.id),
      operatorId: winner.id,
      operatorName: agencies?.[winner.id]?.agency_name || winner.id,
      tier: winner.tier,
      affiliate: isAffiliateSchedule(winner.id),
    };
  }
  return null;
}
