// tests/verify-seo-booking.mjs
// Unit tests for the shared booking-CTA resolver (map panel + static
// /trains/[slug] pages). Run: npm run verify-seo-booking

import fs from "node:fs";
import { resolveRouteBooking } from "../src/lib/routeBooking.mjs";
import OPERATOR_BOOKING from "../data/overrides/operator-booking.json" with { type: "json" };
import OPERATOR_PRICING from "../data/overrides/operator-pricing.json" with { type: "json" };
import { offerFromPricing, offerLd } from "../src/lib/seo/offers.mjs";

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// The committed agencies snapshot + published payload: exactly what the SEO
// build resolves against (src/lib/seo/data.js).
const agencies = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/scraped/backontrack-agencies.json", import.meta.url),
    "utf8",
  ),
).data;
const published = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/published/initial-data.json", import.meta.url),
    "utf8",
  ),
);

// ── European Sleeper: corridor page first, deep link as the fallback ────────
// Route 237 is the Brussels–Prague corridor, which the operator sells on its
// own page — that beats a prefilled search, so this one does NOT preselect.
{
  const r = resolveRouteBooking({
    agencyId: "ES",
    agencies,
    agencyUrl: agencies.ES?.agency_url ?? null,
    origin: "Praha hl.n.",
    dest: "Bruxelles Midi / Brussel Zuid",
    routeId: "237",
    scheduleStops: [],
  });
  check(r != null, "ES: booking resolves");
  check(r?.href === OPERATOR_BOOKING.ES.routePages["237"], "ES: route 237 books through its corridor page");
  check(r?.preselects === false, "ES: a corridor page is not a preselecting deep link");
  check(!!r?.dealsUrl && !!r?.dealsLabel, "ES: last-minute deals link present on the corridor page too");
}

// ── CFR: international trains book on CFR's international shop ──────────────
// bilete.cfrcalatori.ro answers domestic searches well but not cross-border
// ones; CFR sells those on bileteinternationale.cfrcalatori.ro, whose search
// cannot be prefilled from a link we have confirmed, so each international
// route is a `routePages` entry (no preselection). Checked against every CFR
// row in the payload, so a new international CFR row without an entry fails
// here rather than shipping a domestic search for a train to Budapest.
{
  const INTERNATIONAL = "https://bileteinternationale.cfrcalatori.ro/en/booking/search";
  const cfrRows = Object.values(published.data.viewMap).filter((row) =>
    String(row.agency_id || "").split("/").includes("CFR"),
  );
  check(cfrRows.length > 0, "CFR: the payload carries CFR rows");
  let international = 0;
  let domestic = 0;
  for (const row of cfrRows) {
    const countries = [0, 1]
      .flatMap((d) => [row[`origin_country_${d}`], row[`destination_country_${d}`]])
      .filter(Boolean);
    const crossesBorder = countries.some((c) => c !== "RO");
    const r = resolveRouteBooking({
      agencyId: row.agency_id,
      agencies,
      agencyUrl: agencies[row.agency_id]?.agency_url ?? null,
      origin: row.origin_trip_0,
      dest: row.destination_trip_0,
      routeId: String(row.route_id),
      scheduleStops: [],
    });
    const label = `CFR route ${row.route_id} (${row.origin_trip_0} → ${row.destination_trip_0})`;
    if (crossesBorder) {
      international++;
      check(r?.href === INTERNATIONAL, `${label}: international, must book on ${INTERNATIONAL} (got ${r?.href})`);
      check(r?.preselects === false, `${label}: the international shop does not preselect`);
    } else {
      domestic++;
      check(
        r?.href?.startsWith("https://bilete.cfrcalatori.ro/") && r?.preselects === true,
        `${label}: domestic, must keep the preselecting bilete.cfrcalatori.ro search (got ${r?.href})`,
      );
    }
  }
  check(international >= 6, `CFR: expected at least 6 international rows, found ${international}`);
  check(domestic > 0, "CFR: expected domestic rows");
  for (const routeId of Object.keys(OPERATOR_BOOKING.CFR.routePages || {})) {
    check(
      cfrRows.some((row) => String(row.route_id) === routeId),
      `CFR.routePages[${routeId}] names no CFR row in the payload`,
    );
  }
}

// ── European Sleeper deep link, where no corridor page is curated ───────────
{
  const r = resolveRouteBooking({
    agencyId: "ES",
    agencies,
    agencyUrl: agencies.ES?.agency_url ?? null,
    origin: "Praha hl.n.",
    dest: "Bruxelles Midi / Brussel Zuid",
    routeId: "es_no_curated_page",
    scheduleStops: [],
  });
  check(r != null, "ES: booking resolves");
  check(r?.preselects === true, "ES: station-preselecting deep link");
  const praha = OPERATOR_BOOKING.ES.stationNames["Praha hl.n."];
  const bxl = OPERATOR_BOOKING.ES.stationNames["Bruxelles Midi / Brussel Zuid"];
  check(r?.href.includes(praha) && r?.href.includes(bxl), "ES: both station codes substituted");
  check(r?.sellerName === null, "ES: no seller caption for a single-operator id");
  check(!!r?.dealsUrl && !!r?.dealsLabel, "ES: last-minute deals link present");
}

// ── Trenitalia (FS) affiliate deep link with stations prefilled ─────────────
{
  const r = resolveRouteBooking({
    agencyId: "FS",
    agencies,
    agencyUrl: agencies.FS?.agency_url ?? null,
    origin: "Roma Termini",
    dest: "Trieste Centrale",
    routeId: "icn_ICN_775",
    scheduleStops: [],
  });
  check(r != null, "FS: booking resolves");
  check(r?.preselects === true, "FS: station-preselecting deep link");
  check(
    r?.href.includes("minisitiCallBackId=60958"),
    "FS: Trenitalia affiliate callback id present",
  );
  check(
    r?.href.includes("departureStation=Roma%20Termini") &&
      r?.href.includes("arrivalStation=Trieste%20Centrale"),
    `FS: both stations substituted, got ${r?.href}`,
  );
  check(r?.sellerName === null, "FS: no seller caption for a single-operator id");
}

// ── compound id: best component wins and is named ───────────────────────────
{
  const r = resolveRouteBooking({
    agencyId: "UZ/ÖBB",
    agencies,
    agencyUrl: null,
    origin: "Wien Hbf",
    dest: "Kyiv",
  });
  check(r?.preselects === true, "UZ/ÖBB: ÖBB deep link wins the tiering");
  check(
    r?.sellerName === (agencies["ÖBB"]?.agency_name || "ÖBB"),
    "UZ/ÖBB: seller named for compound ids",
  );
}

// ── operator with no curated config falls back to the BoT booking portal ────
{
  const r = resolveRouteBooking({
    agencyId: "UZ",
    agencies,
    agencyUrl: agencies.UZ?.agency_url ?? null,
    origin: "Kyiv",
    dest: "Uzhhorod",
  });
  check(r?.href === agencies.UZ.agency_fare_url, "UZ: agency_fare_url tier");
  check(r?.preselects === false && r?.sellerName === null, "UZ: plain portal link");
}

// ── North America: station codes → deep link; otherwise route landing page ──
{
  const stops = [
    { name: "Lorton Amtrak Auto Train Station", code: "LOR" },
    { name: "Sanford Amtrak Auto Train Station", code: "SFA" },
  ];
  const withCodes = resolveRouteBooking({
    agencyId: "AMTK",
    agencies,
    origin: stops[0].name,
    dest: stops[1].name,
    routeId: "amtrak_Auto_Train",
    scheduleStops: stops,
  });
  check(withCodes?.preselects === true, "AMTK: coded stops build a station deep link");
  check(
    withCodes?.href.includes("LOR") && withCodes?.href.includes("SFA"),
    "AMTK: stop codes substituted",
  );

  const withoutCodes = resolveRouteBooking({
    agencyId: "AMTK",
    agencies,
    origin: stops[0].name,
    dest: stops[1].name,
    routeId: "amtrak_Auto_Train",
    scheduleStops: [],
  });
  check(
    withoutCodes?.href === OPERATOR_BOOKING.AMTK.routePages.amtrak_Auto_Train,
    "AMTK: falls back to the curated route landing page",
  );
  check(withoutCodes?.preselects === false, "AMTK: landing page is not a deep link");
}

{
  const r = resolveRouteBooking({
    agencyId: "VIA",
    agencies,
    origin: "A",
    dest: "B",
    routeId: "via_Unknown_Route",
    scheduleStops: [],
  });
  check(r?.href === OPERATOR_BOOKING.VIA.bookingPageUrl, "VIA: booking entry fallback");
}

// ── Leo Express: station codes + display names + date ───────────────────────
{
  const r = resolveRouteBooking({
    agencyId: "LE",
    agencies,
    agencyUrl: "https://www.leoexpress.com/en",
    origin: "Frankfurt (Main) Süd",
    dest: "Przemyśl Gł.",
    routeId: "270",
    scheduleStops: [],
  });
  check(r != null, "LE: booking resolves");
  check(r?.preselects === true, "LE: station-preselecting deep link");
  check(
    r?.href.includes("from=8002041") && r?.href.includes("to=5100234"),
    `LE: levis_ids substituted, got ${r?.href}`,
  );
  check(
    r?.href.includes("fromName=Frankfurt") && !r?.href.includes("fromName=8002041"),
    "LE: display names are not replaced by the station ids",
  );
  check(/\d{2}\.\d{2}\.\d{4}/.test(r?.href || ""), "LE: date placeholder filled");
}

{
  const r = resolveRouteBooking({
    agencyId: "LE",
    agencies,
    origin: "Unknown Halt",
    dest: "Przemyśl Gł.",
  });
  check(
    r?.href === OPERATOR_BOOKING.LE.bookingPageUrl,
    "LE: unmapped origin falls back to booking page",
  );
  check(r?.preselects === false, "LE: fallback is not a deep link");
}

// ── nothing to link to → null so pages render no button ─────────────────────
{
  const r = resolveRouteBooking({
    agencyId: "XX",
    agencies: {},
    agencyUrl: null,
    origin: "A",
    dest: "B",
  });
  check(r === null, "unknown operator with no data resolves to null");
}

// ── coverage: every published route resolves to a booking CTA ───────────────
// This is the invariant behind "a booking button on every /trains page".
for (const row of Object.values(published.data.viewMap)) {
  const agencyId = (row.agency_id || "").trim();
  const r = resolveRouteBooking({
    agencyId,
    agencies,
    agencyUrl: agencies[agencyId]?.agency_url ?? null,
    origin: row.origin_trip_0 || row.origin_trip_1 || "",
    dest: row.destination_trip_0 || row.destination_trip_1 || "",
    routeId: String(row.route_id),
    scheduleStops: [],
  });
  check(
    !!r?.href,
    `coverage: route ${row.route_id} (${agencyId}) has no booking CTA`,
  );
  // getStaticProps serializes the object into page props — no undefined values.
  if (r) {
    check(
      Object.values(r).every((v) => v !== undefined),
      `coverage: route ${row.route_id} booking has undefined fields`,
    );
  }
}

// ── The price a connection page publishes ──────────────────────────────────
// /connections/[pair] resolves each train's fare through getOperatorPricing()
// and hands it to offerFromPricing(). What matters is that a route with no
// concrete figure publishes nothing at all: an operator record saying only
// "dynamic pricing" must not become an offer of 0, and a page must never quote
// a price the facts tile does not show.
{
  check(
    offerFromPricing({ fromPrice: 39, currency: "EUR" })?.lowPrice === 39,
    "offerFromPricing drops a concrete fare",
  );
  check(
    offerFromPricing({ fromPrice: 12.5, currency: "TRY" })?.currency === "TRY",
    "offerFromPricing keeps the record's own currency",
  );
  check(
    offerFromPricing({ fromPrice: 39 })?.currency === "EUR",
    "offerFromPricing defaults a missing currency to EUR",
  );
  for (const empty of [null, undefined, {}, { type: "dynamic", fromPrice: null }, { fromPrice: 0 }, { fromPrice: "39" }, { fromPrice: NaN }]) {
    check(
      offerFromPricing(empty) === null,
      `offerFromPricing must publish nothing for ${JSON.stringify(empty)}`,
    );
  }
  check(offerLd(null) === null, "offerLd renders nothing without an offer");

  const ld = offerLd(offerFromPricing({ fromPrice: 39, currency: "EUR" }));
  check(ld["@type"] === "AggregateOffer", "a sampled floor is an AggregateOffer, not an Offer");
  check(ld.lowPrice === 39 && ld.priceCurrency === "EUR", "AggregateOffer carries lowPrice + currency");
  check(
    !("url" in ld) && !("price" in ld),
    "the affiliate booking URL and a fixed `price` must stay out of structured data",
  );

  // Today every operator record is a null fromPrice awaiting the review queue,
  // so no page publishes an offer. That is correct, not a bug — but if a figure
  // is ever added, it has to be a real number, not a placeholder string.
  for (const [agencyId, pricing] of Object.entries(OPERATOR_PRICING)) {
    const offer = offerFromPricing(pricing);
    check(
      offer === null || (Number.isFinite(offer.lowPrice) && offer.lowPrice > 0),
      `operator-pricing ${agencyId}: fromPrice must be a positive number or null`,
    );
    check(
      pricing.currency == null || /^[A-Z]{3}$/.test(pricing.currency),
      `operator-pricing ${agencyId}: currency must be an ISO-4217 code`,
    );
  }
}

if (problems.length) {
  console.error(`verify-seo-booking: ${problems.length} problem(s)`);
  for (const p of problems) console.error(" -", p);
  process.exit(1);
}
console.log("verify-seo-booking: OK");
