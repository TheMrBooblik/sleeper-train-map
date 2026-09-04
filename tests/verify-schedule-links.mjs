// tests/verify-schedule-links.mjs
// Unit tests for the "official timetable" helper link: number extraction, the
// four-tier resolution, compound-agency specificity, the per-country picking
// rule, and the shape of the curated table.
// Run: npm run verify-schedule-links

import fs from "node:fs";
import {
  scheduleTrainNumber,
  buildScheduleUrl,
  buildScheduleCandidate,
  pickScheduleCountry,
  getScheduleLabel,
  SCHEDULE_TIERS,
} from "../src/lib/operatorBooking.js";
import { resolveScheduleLink } from "../src/lib/operatorAgencies.mjs";
import { applyOverrideMutation } from "../src/pages/api/lib/overrides-mutate.mjs";
import OPERATOR_BOOKING from "../data/overrides/operator-booking.json" with { type: "json" };

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};
const eq = (actual, expected, msg) =>
  check(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);

// ── Train numbers as the operators' own sites address them ─────────────────
// Ukrainian Railways is the reason this helper exists: the two URLs the site
// produces for trains 1 and 35 carry no leading zeros, while Back-on-Track
// records them "001 D" and "036 Š".
eq(scheduleTrainNumber("001 D"), "1", "UZ 001 D drops leading zeros");
eq(scheduleTrainNumber("036 Š"), "36", "UZ 036 Š drops leading zeros");
eq(scheduleTrainNumber("351 K"), "351", "UZ 351 K keeps a 3-digit number");
// Compound Back-on-Track labels: the first leg is the one we link to.
eq(scheduleTrainNumber("IRN 1954/R 8824"), "1954", "compound label takes leg 1");
eq(scheduleTrainNumber("EN 443 / IC 406"), "443", "spaced compound takes leg 1");
eq(scheduleTrainNumber("12503/460"), "12503", "numeric compound takes leg 1");
// Short and suffixed numbers that the panel's /\d{3,5}/ lookup key cannot see.
eq(scheduleTrainNumber("IRN / IC 78"), "78", "two-digit number is found");
eq(scheduleTrainNumber("1003 (G)"), "1003", "parenthesised suffix is dropped");
eq(scheduleTrainNumber("EN 40459"), "40459", "five-digit number survives");
eq(scheduleTrainNumber("Sleeper (Penzance)"), "", "no digits → empty string");
eq(scheduleTrainNumber(null), "", "null → empty string");

// ── Tier 1: per-route pages beat everything ────────────────────────────────
eq(
  buildScheduleCandidate({ agencyId: "ES", train: "452", routeId: "237" })?.tier,
  "route",
  "European Sleeper route 237 resolves at the route tier",
);
eq(
  buildScheduleUrl({ agencyId: "ES", train: "452", routeId: "237" }),
  "https://www.europeansleeper.eu/night-train-brussels-prague",
  "ES 452 links to the Brussels–Prague corridor page",
);
// A route with no curated page falls through to the operator timetable.
eq(
  buildScheduleCandidate({ agencyId: "ES", train: "454", routeId: "239" })?.tier,
  "operator",
  "ES 454 (no curated page) falls back to the operator tier",
);

// ── Tier 2: per-train templates ────────────────────────────────────────────
eq(
  buildScheduleUrl({ agencyId: "UZ", train: "001 D", routeId: "164" }),
  "https://uz.gov.ua/en/passengers/timetable/?ntrain=1&ntrain_out=1&by_number=Search",
  "UZ train 1 reproduces the operator's own search URL",
);
eq(
  buildScheduleUrl({ agencyId: "ČD", train: "EN 442", routeId: "6" }),
  "https://www.cd.cz/en/vlak/442",
  "ČD links to its per-train page",
);
// Route 60 is the joint ÖBB/UZ Wien–Kyiv train, whose "40149" is an ÖBB-format
// number UZ's search does not know — the hard-mapped page must win.
eq(
  buildScheduleCandidate({ agencyId: "UZ", train: "40149", routeId: "60" })?.tier,
  "route",
  "UZ route 60 is hard-mapped away from a dead by-number search",
);
// A {train} template with nothing to substitute must not link to a blank search.
check(
  buildScheduleUrl({ agencyId: "UZ", train: "no digits here", routeId: "x" }) === null,
  "a {train} template with no number yields no link",
);
// {date} is substituted as dd.MM.yyyy.
check(
  /\?Date=\d{2}\.\d{2}\.\d{4}$/.test(
    buildScheduleUrl({ agencyId: "CFR", train: "IC 472", routeId: "12" }) || "",
  ),
  "CFR template renders a dd.MM.yyyy date",
);
eq(
  buildScheduleUrl({ agencyId: "CFR", train: "IC 472", routeId: "12", date: "04.09.2026" }),
  "https://bilete.cfrcalatori.ro/en-GB/Train/472?Date=04.09.2026",
  "CFR reproduces the operator's own per-train URL",
);

// ── Tier 3: per-country pages, and the picking rule ────────────────────────
// Nightjet's destination pages answer "where does this train go", so the
// destination wins unless it is the operator's own country.
eq(
  pickScheduleCountry({ agencyId: "ÖBB", originCountry: "CH", destCountry: "NL" }),
  "NL",
  "Zürich→Amsterdam keys to the Netherlands",
);
eq(
  pickScheduleCountry({ agencyId: "ÖBB", originCountry: "BE", destCountry: "AT" }),
  "BE",
  "Bruxelles→Wien keys to Belgium, not ÖBB's own Austria",
);
eq(
  pickScheduleCountry({ agencyId: "ÖBB", originCountry: "DE", destCountry: "IT" }),
  "IT",
  "Stuttgart→Venezia (both abroad) follows the destination",
);
eq(
  pickScheduleCountry({ agencyId: "ÖBB", originCountry: "AT", destCountry: "AT" }),
  "AT",
  "a domestic route still yields the home country",
);
eq(
  buildScheduleUrl({
    agencyId: "ÖBB",
    train: "NJ 421",
    routeId: "nj_standalone_NJ_421",
    originCountry: "NL",
    destCountry: "AT",
  }),
  "https://www.nightjet.com/en/reiseziele/niederlande",
  "ÖBB NJ 421 lands on the Netherlands destinations page",
);
// Austria and Romania have no curated slug (umlaut spelling unconfirmed), so
// they must degrade to the destinations index rather than guess a 404.
eq(
  buildScheduleCandidate({
    agencyId: "ÖBB",
    train: "NJ 19947",
    routeId: "x",
    originCountry: "AT",
    destCountry: "AT",
  })?.tier,
  "operator",
  "an unslugged country falls back to the destinations index",
);

// ── Compound agency ids resolve by specificity, not by seller ──────────────
// "CFM/CFR": CFM has only an operator page, CFR a per-train one. The reader is
// asking where to check this train's times, so the specific link wins.
const cfm = resolveScheduleLink({ agencyId: "CFM/CFR", train: "401", routeId: "22" });
eq(cfm?.operatorId, "CFR", "CFM/CFR picks CFR's per-train link");
eq(cfm?.tier, "train", "CFM/CFR resolves at the train tier");
// A component with no schedule config contributes nothing.
const rdc = resolveScheduleLink({ agencyId: "RDC/SJ", train: "EN 345", routeId: "x" });
eq(rdc?.operatorId, "RDC", "RDC/SJ picks RDC (SJ has no schedule config)");
// Operators deliberately left out must produce no link at all.
for (const id of ["CR", "GWR", "OTE", "SCR", "SJ", "RJ", "GA"]) {
  check(
    resolveScheduleLink({ agencyId: id, train: "1", routeId: "x" }) === null,
    `${id} has no schedule link (its best page duplicates the booking link, or none is confirmed)`,
  );
}
check(
  resolveScheduleLink({ agencyId: "", train: "1", routeId: "x" }) === null,
  "an empty agency id yields no link",
);

// ── Labels + affiliate marking ─────────────────────────────────────────────
eq(getScheduleLabel("UZ"), "Official timetable", "default label");
eq(getScheduleLabel("nope"), "Official timetable", "unknown operator gets the default label");
check(
  resolveScheduleLink({ agencyId: "ČD", train: "EN 442", routeId: "6" })?.affiliate === false,
  "an unwrapped operator is not marked as affiliate",
);
// The wrapper is inert until an id is configured, but must encode when set.
{
  const wrapped = buildScheduleUrl({
    agencyId: "__test__",
    train: "1",
    routeId: "r",
  });
  check(wrapped === null, "an operator absent from the table yields no link");
}

// ── The curated table itself ───────────────────────────────────────────────
const scheduleOps = Object.entries(OPERATOR_BOOKING).filter(
  ([, v]) =>
    v.scheduleUrl || v.scheduleUrlTemplate || v.schedulePages || v.scheduleCountryPages,
);
check(scheduleOps.length >= 25, `at least 25 operators carry a schedule link (got ${scheduleOps.length})`);

for (const [id, cfg] of scheduleOps) {
  const urls = [
    cfg.scheduleUrl,
    ...Object.values(cfg.schedulePages || {}),
    ...Object.values(cfg.scheduleCountryPages || {}),
  ].filter(Boolean);
  for (const url of urls) {
    check(
      /^https:\/\/[^\s{}]+$/.test(url),
      `${id}: "${url}" must be an absolute https URL with no unsubstituted placeholder`,
    );
  }
  if (cfg.scheduleUrlTemplate) {
    check(
      cfg.scheduleUrlTemplate.startsWith("https://"),
      `${id}: scheduleUrlTemplate must be https`,
    );
    check(
      cfg.scheduleUrlTemplate.includes("{train}"),
      `${id}: scheduleUrlTemplate must carry {train} (that is what makes it per-train)`,
    );
    // Every placeholder must be one the builder knows how to substitute.
    for (const ph of cfg.scheduleUrlTemplate.match(/\{[a-zA-Z]+\}/g) || []) {
      check(
        ["{train}", "{date}"].includes(ph),
        `${id}: unknown placeholder ${ph} in scheduleUrlTemplate`,
      );
    }
  }
  if (cfg.scheduleCountryPages) {
    for (const code of Object.keys(cfg.scheduleCountryPages)) {
      check(/^[A-Z]{2}$/.test(code), `${id}: "${code}" must be an ISO-2 country code`);
    }
    check(
      Boolean(cfg.scheduleUrl),
      `${id}: an operator with country pages needs a scheduleUrl fallback for uncovered countries`,
    );
  }
}

// ── Admin edits must not silently drop the config ──────────────────────────
{
  const before = {
    UZ: {
      urlTemplate: null,
      stationNames: {},
      scheduleUrlTemplate: "https://uz.gov.ua/x?ntrain={train}",
      schedulePages: { 60: "https://uz.gov.ua/en/passengers/timetable/" },
      scheduleLabel: "Timetable",
      homeCountry: "UA",
    },
  };
  const after = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "UZ", urlTemplate: "https://booking.example/{origin}" },
    before,
  );
  eq(
    after.UZ.scheduleUrlTemplate,
    "https://uz.gov.ua/x?ntrain={train}",
    "a booking-URL edit preserves scheduleUrlTemplate",
  );
  eq(after.UZ.schedulePages?.["60"], before.UZ.schedulePages["60"], "…and schedulePages");
  eq(after.UZ.scheduleLabel, "Timetable", "…and scheduleLabel");
  eq(after.UZ.homeCountry, "UA", "…and homeCountry");
  eq(after.UZ.urlTemplate, "https://booking.example/{origin}", "…while applying the edit itself");
}

// ── Tier order is the contract the resolver relies on ──────────────────────
eq(SCHEDULE_TIERS.join(","), "route,train,country,operator", "tier order is most-specific first");

// ── Against the real published payload ─────────────────────────────────────
{
  const published = JSON.parse(
    fs.readFileSync("public/data/published/initial-data.json", "utf8"),
  ).data;
  const rows = Object.values(published.viewMap);
  let linked = 0;
  const tiers = {};
  for (const row of rows) {
    const link = resolveScheduleLink({
      agencyId: row.bot_agency_id || row.agency_id,
      train: row.trip_short_name_0,
      routeId: String(row.route_id),
      originCountry: row.origin_country_0,
      destCountry: row.destination_country_0,
    });
    if (!link) continue;
    linked++;
    tiers[link.tier] = (tiers[link.tier] || 0) + 1;
    check(
      link.url.startsWith("https://"),
      `route ${row.route_id}: resolved URL must be https (got ${link.url})`,
    );
  }
  check(linked >= 200, `at least 200 published routes resolve a link (got ${linked})`);
  check(tiers.train >= 80, `per-train links cover the UZ/CFR/ČD block (got ${tiers.train || 0})`);
  check(tiers.country >= 20, `per-country links cover the ÖBB block (got ${tiers.country || 0})`);
  check(tiers.route >= 8, `per-route links cover ES/VIA/SJN (got ${tiers.route || 0})`);

  // The country tier only works because the merge stamps endpoint countries.
  const stamped = rows.filter((r) => r.origin_country_0 || r.destination_country_0);
  check(
    stamped.length >= 150,
    `the merge stamps endpoint countries on the Back-on-Track rows (got ${stamped.length})`,
  );
}

if (problems.length) {
  console.error(`verify-schedule-links: ${problems.length} problem(s)`);
  for (const p of problems) console.error(" -", p);
  process.exit(1);
}
console.log("verify-schedule-links: OK");
