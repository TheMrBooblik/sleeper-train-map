// tests/verify-operator-agencies.mjs
// Unit tests for the compound-operator resolution helper (multi-logo row +
// tiered booking CTA). Run: npm run verify-operator-agencies

import {
  splitAgencyIds,
  resolveOperatorComponents,
  resolveBookingHref,
  formatTrainNumber,
} from "../src/lib/operatorAgencies.mjs";
import OPERATOR_BOOKING from "../data/overrides/operator-booking.json" with { type: "json" };

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// Minimal BoT-shaped agencies fixture (real field names, fake URLs kept short).
const AGENCIES = {
  "ÖBB": {
    agency_name: "ÖBB-Personenverkehr AG",
    agency_url: "https://personenverkehr.oebb.at",
    agency_fare_url: "https://www.nightjet.com/",
    agency_logo_url: "https://back-on-track.eu/logo_obb.jpg",
  },
  "ČD": {
    agency_name: "České dráhy a.s.",
    agency_url: "https://www.cd.cz",
    agency_fare_url: "https://www.cd.cz/en/nase-vlaky/nocni-vlaky/-27543/",
    agency_logo_url: "https://back-on-track.eu/logo_cd.jpg",
  },
  PKP: {
    agency_name: "PKP Intercity S.A.",
    agency_url: "https://www.intercity.pl",
    agency_fare_url: "",
    agency_logo_url: "https://back-on-track.eu/logo_pkp.jpg",
  },
  UZ: {
    agency_name: "Укрзалізниця",
    agency_url: "https://www.uz.gov.ua/",
    agency_fare_url: "https://booking.uz.gov.ua/",
    agency_logo_url: "https://back-on-track.eu/logo_uz.jpg",
  },
  RDC: {
    agency_name: "RDC Deutschland",
    agency_url: "https://www.rdc-deutschland.de",
    agency_fare_url: "https://www.nachtexpress.de/en/booking/",
    agency_logo_url: "https://back-on-track.eu/logo_rdc.jpg",
  },
  "ŽPCG": {
    agency_name: "Željeznički prevoz Crne Gore AD",
    agency_url: "https://www.zcg-prevoz.me",
    agency_fare_url: "",
    agency_logo_url: "https://back-on-track.eu/logo_zpcg.jpg",
  },
};

// ── splitAgencyIds ────────────────────────────────────────────────────────────
check(
  JSON.stringify(splitAgencyIds("PKP/ČD")) === '["PKP","ČD"]',
  "split: PKP/ČD → [PKP, ČD]",
);
check(
  JSON.stringify(splitAgencyIds(" RDC / SJ ")) === '["RDC","SJ"]',
  "split: trims whitespace around segments",
);
check(
  JSON.stringify(splitAgencyIds("TCDD/BDŽ/CFR")) === '["TCDD","BDŽ","CFR"]',
  "split: three-way compound",
);
check(JSON.stringify(splitAgencyIds("ÖBB")) === '["ÖBB"]', "split: single id");
check(splitAgencyIds("").length === 0, "split: empty string → []");
check(splitAgencyIds(null).length === 0, "split: null → []");
check(
  JSON.stringify(splitAgencyIds("PKP//ČD")) === '["PKP","ČD"]',
  "split: drops empty segments",
);

// ── resolveOperatorComponents ────────────────────────────────────────────────
{
  const comps = resolveOperatorComponents({
    agencyId: "PKP/ČD",
    agencies: AGENCIES,
    origin: "Warszawa Wschodnia",
    dest: "Praha hl.n.",
  });
  check(comps.length === 2, "components: PKP/ČD yields two entries");
  check(comps[0].id === "PKP" && comps[1].id === "ČD", "components: order preserved");
  check(comps[0].name === "PKP Intercity S.A.", "components: BoT name resolved");
  check(!!comps[0].logoUrl, "components: logo url resolved");
  check(comps[1].fareUrl?.includes("cd.cz"), "components: ČD fare url from agencies");
  // ČD has no deep link; its link should be booking page (if curated) or fare url.
  check(
    comps[1].linkUrl != null && comps[1].linkKind != null,
    "components: ČD gets a link (page or fare tier)",
  );
}

{
  // Unknown-to-BoT id with a curated booking entry (VIA) keeps booking fields.
  const comps = resolveOperatorComponents({
    agencyId: "VIA",
    agencies: AGENCIES,
    origin: "Vancouver",
    dest: "Toronto",
  });
  check(comps.length === 1, "components: unknown id survives");
  check(comps[0].name === "VIA", "components: name falls back to id");
  check(comps[0].logoUrl === null, "components: no logo for non-BoT id");
  check(
    comps[0].bookingPageUrl === (OPERATOR_BOOKING.VIA?.bookingPageUrl ?? null),
    "components: curated bookingPageUrl still applies",
  );
}

{
  // Empty agencies map (initial client load) must not throw and yields no links
  // for operators without curated booking config.
  const comps = resolveOperatorComponents({
    agencyId: "ŽS/ŽPCG",
    agencies: undefined,
    origin: "Beograd Centar",
    dest: "Bar",
  });
  check(comps.length === 2, "components: works while agencies still loading");
  check(comps[0].logoUrl === null && comps[1].logoUrl === null, "components: no logos without agencies");
}

// ── resolveBookingHref tiering ───────────────────────────────────────────────
{
  // ÖBB has a real deep-link template with plain station names — a compound
  // UZ/ÖBB should resolve the CTA to the ÖBB deep link, not UZ's portal.
  const r = resolveBookingHref({
    agencyId: "UZ/ÖBB",
    agencies: AGENCIES,
    agencyUrl: "https://example.com",
    origin: "Wien Hbf",
    dest: "Kyiv",
  });
  check(r.componentId === "ÖBB", "cta: deep-link tier wins across components");
  check(!!r.deepLink && r.href === r.deepLink, "cta: href is the deep link");
  check(r.href.includes(encodeURIComponent("Wien Hbf")), "cta: origin substituted");
}

{
  // RDC/SJ: neither has a deep link for arbitrary stations; RDC's fare url
  // should win over SJ (assuming no curated SJ deep link fires without mapping).
  const r = resolveBookingHref({
    agencyId: "RDC/SJ",
    agencies: AGENCIES,
    agencyUrl: null,
    origin: "Berlin Hbf",
    dest: "Stockholm Central",
  });
  check(r.href != null, "cta: RDC/SJ gets a CTA");
  check(r.deepLink === null || r.href === r.deepLink, "cta: deepLink consistent with href");
}

{
  // ŽPCG alone: no curated entry, no fare url → homepage tier.
  const r = resolveBookingHref({
    agencyId: "ŽPCG",
    agencies: AGENCIES,
    agencyUrl: null,
    origin: "Beograd Centar",
    dest: "Bar",
  });
  check(r.href === "https://www.zcg-prevoz.me", "cta: homepage tier fallback");
}

{
  // Nothing at all → caller-supplied agencyUrl.
  const r = resolveBookingHref({
    agencyId: "XX",
    agencies: {},
    agencyUrl: "https://fallback.example",
    origin: "A",
    dest: "B",
  });
  check(r.href === "https://fallback.example", "cta: agencyUrl last-ditch fallback");
  check(r.componentId === null, "cta: no winning component reported");
}

// ── single-agency back-compat: deepLink || bookingPageUrl || agencyUrl ──────
{
  const r = resolveBookingHref({
    agencyId: "SNCF",
    agencies: {},
    agencyUrl: "https://www.sncf.com",
    origin: "Paris Austerlitz",
    dest: "Nice-Ville",
  });
  check(
    r.href === (OPERATOR_BOOKING.SNCF?.bookingPageUrl ?? "https://www.sncf.com"),
    "back-compat: SNCF resolves to curated booking page",
  );
}

// ── every published agency id yields a CTA (with agencies data present) ─────
// Uses the committed seed file so the test exercises real BoT data.
import fs from "node:fs";
import { OPERATORS } from "../src/lib/seo/operatorNames.mjs";

const seeded = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/scraped/backontrack-agencies.json", import.meta.url),
    "utf8",
  ),
);
const published = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/published/initial-data.json", import.meta.url),
    "utf8",
  ),
);
const agencyIds = new Set(
  Object.values(published.data.viewMap)
    .map((row) => (row.agency_id || "").trim())
    .filter(Boolean),
);
for (const id of agencyIds) {
  const r = resolveBookingHref({
    agencyId: id,
    agencies: seeded.data,
    agencyUrl: null,
    origin: "A",
    dest: "B",
  });
  check(r.href != null, `coverage: agency "${id}" has no booking CTA`);
}

// ── every published agency component has a long display name ────────────────
// Prefer the curated OPERATORS table; otherwise the BoT agency_name. Missing
// both means SEO would fall back to a bare id (the Leo Express / "LE" bug).
for (const compound of agencyIds) {
  for (const id of splitAgencyIds(compound)) {
    const curated = OPERATORS[id]?.name;
    const botName =
      seeded.data[id]?.agency_name_romanized || seeded.data[id]?.agency_name;
    check(
      Boolean(curated || botName),
      `coverage: agency "${id}" has no long name (add to operatorNames.mjs or BoT agencies)`,
    );
  }
}

// Explicit Leo Express check so the curated slug/name stay intentional.
// ── formatTrainNumber ───────────────────────────────────────────────────────
// Most feeds carry the operator's own prefix; a few publish bare numbers
// because that is what Back-on-Track's trip_short_name holds. European Sleeper
// is the one that needs relabelling today — its ES 400 arrives as "400".

check(formatTrainNumber("400", "ES") === "ES 400", 'ES "400" renders as "ES 400"');
check(formatTrainNumber("452", "ES") === "ES 452", 'ES "452" renders as "ES 452"');
// A number that already carries letters is the operator's own label.
check(formatTrainNumber("NJ 421", "ÖBB") === "NJ 421", '"NJ 421" is left alone');
check(formatTrainNumber("EN 40459", "ÖBB") === "EN 40459", '"EN 40459" is left alone');
check(formatTrainNumber("ES 400", "ES") === "ES 400", "already-prefixed ES is idempotent");
// An operator with no declared prefix keeps its bare number rather than being
// dressed in its agency id: Back-on-Track's SJN 475 and CFM/CFR 401 collide
// with European Sleeper's numbers and must not borrow its label either.
check(formatTrainNumber("475", "SJN") === "475", "SJN 475 keeps its bare number");
check(formatTrainNumber("401", "CFM/CFR") === "401", "CFM/CFR 401 keeps its bare number");
check(formatTrainNumber("1020", "RJ") === "1020", "RJ 1020 keeps its bare number");
// Degenerate input must not produce a stray prefix or throw.
check(formatTrainNumber("", "ES") === "", "empty number stays empty");
check(formatTrainNumber(null, "ES") === "", "null number stays empty");
check(formatTrainNumber("400", "") === "400", "no agency → unchanged");
check(formatTrainNumber("400", null) === "400", "null agency → unchanged");
// ── Per-route booking pages outrank a prefilled search ─────────────────────
// Where an operator publishes a page for this exact corridor, that is the page
// they sell the route on; a station-preselect deep link is the fallback.
{
  const withRoute = resolveBookingHref({
    agencyId: "ES",
    agencies: AGENCIES,
    origin: "Praha hl.n.",
    dest: "Bruxelles Midi",
    routeId: "237",
  });
  check(
    withRoute.href === OPERATOR_BOOKING.ES.routePages["237"],
    `ES route 237 books through its corridor page (got ${withRoute.href})`,
  );
  check(
    withRoute.deepLink === null,
    "a route page is not a deep link, so the caller shows no preselect caption",
  );
  // A route with no curated page keeps the station-preselect deep link.
  const noRoute = resolveBookingHref({
    agencyId: "ES",
    agencies: AGENCIES,
    origin: "Praha hl.n.",
    dest: "Bruxelles Midi",
    routeId: "unmapped",
  });
  check(
    noRoute.href?.includes("booking.europeansleeper.eu"),
    `an unmapped ES route still deep-links into the booking engine (got ${noRoute.href})`,
  );
  check(noRoute.deepLink !== null, "…and that one does count as a deep link");
  // Omitting routeId entirely must behave exactly as before this tier existed.
  const legacy = resolveBookingHref({
    agencyId: "ES",
    agencies: AGENCIES,
    origin: "Praha hl.n.",
    dest: "Bruxelles Midi",
  });
  check(legacy.href === noRoute.href, "resolving without a routeId is unchanged");
  // All three running corridors book through the operator's own page for that
  // corridor, each through the affiliate redirect exactly once.
  for (const [routeId, slug] of [
    ["237", "night-train-brussels-prague"],
    ["238", "night-train-paris-berlin"],
    ["es_400", "night-train-brussels-milan"],
  ]) {
    const href = resolveBookingHref({
      agencyId: "ES",
      agencies: AGENCIES,
      origin: "Praha hl.n.",
      dest: "Bruxelles Midi",
      routeId,
    }).href;
    check(
      href?.includes(encodeURIComponent(`/${slug}`)),
      `ES route ${routeId} books through /${slug} (got ${href})`,
    );
    check(
      (href?.match(/deals\.europeansleeper\.eu/g) || []).length === 1,
      `ES route ${routeId} passes the affiliate redirect once`,
    );
  }

  // Every curated booking route page must be an absolute URL.
  for (const [id, cfg] of Object.entries(OPERATOR_BOOKING)) {
    for (const [routeId, url] of Object.entries(cfg.routePages || {})) {
      check(
        /^https:\/\/[^\s]+$/.test(url),
        `${id}.routePages[${routeId}] must be an absolute https URL (got ${url})`,
      );
    }
  }
}

check(formatTrainNumber(" 400 ", "ES") === "ES 400", "surrounding whitespace is trimmed");

check(OPERATORS.LE?.name === "Leo Express", 'LE curated name is "Leo Express"');
check(OPERATORS.LE?.slug === "leo-express", 'LE curated slug is "leo-express"');


if (problems.length) {
  console.error(`verify-operator-agencies: ${problems.length} problem(s)`);
  for (const p of problems) console.error(" -", p);
  process.exit(1);
}
console.log("verify-operator-agencies: OK");
