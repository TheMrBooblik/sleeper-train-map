/**
 * Booking guides: how buying a ticket actually works on a train whose booking
 * has quirks a Book button cannot explain (data/overrides/booking-guides.json).
 *
 * The Sunrise Izumo / Seto is why this exists. Its tickets go on sale one month
 * ahead at 10:00 Japan time and the rooms sell out in minutes; a twin room is
 * booked for "1 adult" and the second traveller then needs a basic-fare ticket
 * of their own; tickets are collected from a machine with a PIN. A traveller
 * who knows none of that and presses Book loses the room — so the guide sits
 * beside the Book button on the connection page and in the map panel, and its
 * questions join the page's FAQ.
 *
 * `.mjs` with the JSON imported under an import attribute — the same way
 * operatorBooking.js reads its table — so the map panel, the static pages and
 * raw-node tests all load this one file and resolve a route to the same guide.
 * `bookingGuideFor` takes the table as an argument so a test can hand it one.
 */

import BOOKING_GUIDES from "../../data/overrides/booking-guides.json" with { type: "json" };
import { splitAgencyIds } from "./seo/operatorNames.mjs";

export { BOOKING_GUIDES };

/**
 * The guide for a route's operator(s), or null. A compound agency id matches
 * when any of its operators has a guide — the booking quirk belongs to the
 * train, whoever else is named beside the seller.
 *
 * @param {{guides?: object}|null} table  the parsed booking-guides.json
 * @param {{agencyId?: string, agencyIds?: string[]}} route
 * @returns {object|null} the guide, with its `id`
 */
export function bookingGuideFor(table, { agencyId = "", agencyIds = null } = {}) {
  const ids = new Set(
    (agencyIds ?? []).flatMap((id) => splitAgencyIds(id)).concat(splitAgencyIds(agencyId)),
  );
  if (!ids.size) return null;
  for (const [id, guide] of Object.entries(table?.guides ?? {})) {
    if ((guide?.agencyIds ?? []).some((a) => ids.has(a))) return { id, ...guide };
  }
  return null;
}

const HOW_TO_BOOK = /^how do i book\b/i;

/**
 * A page's FAQ with the guide folded in: the generic "how do I book" answer
 * becomes the guide's specific one, and the guide's own questions follow,
 * skipping any the page already asks. Returns a new array.
 *
 * @param {{q:string,a:string}[]} faq
 * @param {object|null} guide
 */
export function withBookingGuideFaq(faq, guide) {
  const list = Array.isArray(faq) ? faq : [];
  if (!guide) return list;
  const out = list.map((item) =>
    guide.bookingAnswer && HOW_TO_BOOK.test(item.q) ? { ...item, a: guide.bookingAnswer } : item,
  );
  const asked = new Set(out.map((item) => item.q.trim().toLowerCase()));
  for (const item of guide.faq ?? []) {
    if (!item?.q || !item?.a) continue;
    if (asked.has(item.q.trim().toLowerCase())) continue;
    asked.add(item.q.trim().toLowerCase());
    out.push({ q: item.q, a: item.a });
  }
  return out;
}

/**
 * Just what a page needs to render and serialise — no internal keys.
 * @param {object|null} guide
 */
export function guideProps(guide) {
  if (!guide) return null;
  return {
    id: guide.id,
    title: guide.title ?? "",
    panelTitle: guide.panelTitle ?? "",
    summary: guide.summary ?? "",
    highlights: guide.highlights ?? [],
    sections: (guide.sections ?? []).filter((s) => s?.heading && s.points?.length),
    sources: (guide.sources ?? []).filter((s) => s?.url && s?.label),
    furtherReading: (guide.furtherReading ?? []).filter((s) => s?.url && s?.label),
    checkedAt: guide.checkedAt ?? null,
  };
}

/** The guide for a route from the committed table (see bookingGuideFor). */
export function getBookingGuide(route) {
  return bookingGuideFor(BOOKING_GUIDES, route);
}
