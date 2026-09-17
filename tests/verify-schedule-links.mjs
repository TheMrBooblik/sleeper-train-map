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
import {
  resolveScheduleLink,
  trainLegForOperator,
} from "../src/lib/operatorAgencies.mjs";
import { applyOverrideMutation } from "../src/pages/api/lib/overrides-mutate.mjs";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";
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
  buildScheduleCandidate({ agencyId: "VIA", train: "1", routeId: "via_Vancouver_-_Toronto" })?.tier,
  "route",
  "a curated per-route page resolves at the route tier",
);
eq(
  buildScheduleUrl({ agencyId: "VIA", train: "1", routeId: "via_Vancouver_-_Toronto" }),
  "https://www.viarail.ca/en/plan/train-schedules/vancouver-jasper-winnipeg-toronto",
  "VIA's Canadian links to its own route schedule",
);
// A route with no curated page falls through to the operator timetable.
eq(
  buildScheduleCandidate({ agencyId: "VIA", train: "1", routeId: "unmapped" })?.tier,
  "operator",
  "an unmapped route falls back to the operator tier",
);
// European Sleeper publishes one timetable page covering every corridor, so
// all of its routes point there rather than at per-corridor marketing pages —
// and every ES link goes through the operator's affiliate redirect.
for (const routeId of ["237", "238", "239", "es_400", "es_400_from_20261214"]) {
  const url = buildScheduleUrl({ agencyId: "ES", train: "452", routeId });
  eq(
    url,
    OPERATOR_BOOKING.ES.scheduleUrl,
    `ES route ${routeId} links to the single timetable page`,
  );
  check(
    url?.startsWith("https://deals.europeansleeper.eu/") && url.includes("u=%2Ftimetable"),
    `ES route ${routeId} reaches the timetable through the affiliate redirect (got ${url})`,
  );
  check(
    (url?.match(/deals\.europeansleeper\.eu/g) || []).length === 1,
    `ES route ${routeId} is not wrapped twice`,
  );
}
eq(
  resolveScheduleLink({ agencyId: "ES", train: "452", routeId: "237" })?.affiliate,
  true,
  "ES timetable links are marked affiliate, so the caller renders rel=sponsored",
);
// The wrapper stays safe over values that are already wrapped (ES stores them
// that way, because the redirect's u= takes a site-relative path) while still
// wrapping a plain URL.
{
  const wrapper = OPERATOR_BOOKING.ES.affiliateWrapper;
  check(
    typeof wrapper === "string" && wrapper.includes("{target}"),
    "ES declares an affiliate wrapper carrying {target}",
  );
  for (const url of Object.values(OPERATOR_BOOKING.ES.routePages || {})) {
    check(
      (url.match(/deals\.europeansleeper\.eu/g) || []).length === 1,
      `a stored ES route page is wrapped exactly once (got ${url})`,
    );
  }
}

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
// Nightjet transliterates umlauts rather than carrying them in the path
// (Österreich → oesterreich), which is what a domestic Austrian route keys to.
eq(
  buildScheduleUrl({
    agencyId: "ÖBB",
    train: "NJ 447",
    routeId: "x",
    originCountry: "AT",
    destCountry: "AT",
  }),
  "https://www.nightjet.com/en/reiseziele/oesterreich",
  "a domestic Austrian route lands on the transliterated Austria page",
);
// A country with no curated page still degrades to the destinations index
// rather than guessing a slug that may 404.
eq(
  buildScheduleCandidate({
    agencyId: "ÖBB",
    train: "NJ 1",
    routeId: "x",
    originCountry: "SE",
    destCountry: "SE",
  })?.tier,
  "operator",
  "an unslugged country falls back to the destinations index",
);

// ── A joint train's legs cannot be attributed to their operators ───────────
// Back-on-Track lists one leg per operator, in travel order — which the agency
// id does not follow. Under the same "PKP/ČD" id, route 9 (Praha → Warszawa)
// writes ČD's EN 443 first and route 265 writes PKP's TLK 403 first, so
// pairing by position links one of them to the other operator's train.
eq(
  trainLegForOperator("EN 443 / IC 406", "PKP/ČD"),
  null,
  "a compound label under a compound id is not attributable",
);
eq(
  trainLegForOperator("12503/492", "TCDD/BDŽ"),
  null,
  "…including when the leg and operator counts happen to match",
);
// Through cars of ONE operator are a different thing and keep their first leg.
eq(
  trainLegForOperator("IRN 1954/R 8824", "CFR"),
  "IRN 1954/R 8824",
  "a compound label under a single operator is left alone",
);
eq(trainLegForOperator("ICF 8627", "BDŽ"), "ICF 8627", "a plain label is left alone");
// End to end: those rows fall back rather than link to a wrong train.
for (const [routeId, agencyId, train] of [
  ["9", "PKP/ČD", "EN 443 / IC 406"],
  ["265", "PKP/ČD", "TLK 403/50171"],
  ["27", "TCDD/BDŽ", "12503/492"],
  ["16", "CFR/MÁV", "IRN / IC 78"],
]) {
  eq(
    resolveScheduleLink({ agencyId, train, routeId })?.tier,
    "operator",
    `route ${routeId} (${agencyId}) falls back rather than guess whose leg is whose`,
  );
}

// ── Bulgarian Railways: per-train, by number and date ──────────────────────
// The operator's own URL for ICF 8627 is /en/train-info/8627/08.09.2026.
{
  const url = buildScheduleUrl({ agencyId: "BDŽ", train: "ICF 8627", routeId: "134" });
  check(
    /^https:\/\/razpisanie\.bdz\.bg\/en\/train-info\/8627\/\d{2}\.\d{2}\.\d{4}$/.test(url || ""),
    `BDŽ builds the operator's per-train URL (got ${url})`,
  );
  eq(
    buildScheduleUrl({ agencyId: "BDŽ", train: "ICF 8627", routeId: "134", date: "08.09.2026" }),
    "https://razpisanie.bdz.bg/en/train-info/8627/08.09.2026",
    "BDŽ reproduces the operator's own URL",
  );
}

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

// ── Norway: the timetable is a PDF, and the label has to say so ────────────
// All four Norwegian night routes publish their timetable as a PDF rather than a
// page, keyed per route because one PDF is one line: Vy's Bergensbanen (605/606),
// SJ Nord's Dovre (405/406) and Nordland (475/476), Go-Ahead's Sørtoget (F5
// 725/726). Go-Ahead had no schedule link at all before — no operator page was
// ever confirmed for it — so its entry is a route-tier link with nothing beneath.
{
  const NORWAY = [
    ["GA", "65", "F5 725", "cdn.sanity.io"],
    ["VY", "69", "605", "vy.no"],
    ["SJN", "70", "405", "sj.no"],
    ["SJN", "71", "475", "sj.no"],
  ];
  for (const [agencyId, routeId, train, host] of NORWAY) {
    const link = resolveScheduleLink({ agencyId, train, routeId });
    check(Boolean(link), `${agencyId} route ${routeId} has a timetable link`);
    if (!link) continue;
    eq(link.tier, "route", `${agencyId} route ${routeId} resolves at the route tier`);
    check(
      link.url.startsWith(`https://www.${host}/`) || link.url.startsWith(`https://${host}/`),
      `${agencyId} route ${routeId} links to ${host} (got ${link.url})`,
    );
    check(/\.pdf$/i.test(link.url), `${agencyId} route ${routeId} links to a PDF`);
    eq(
      link.label,
      "Official timetable (PDF)",
      `${agencyId} route ${routeId} says the link is a PDF`,
    );
  }

  // The label follows the URL, not the operator — which is the whole reason it
  // takes one. Vy's route-tier link for 605 is a PDF while the operator-tier
  // fallback behind it is an ordinary page, so a per-operator flag would have to
  // be wrong about one of the two.
  const vyFallback = resolveScheduleLink({ agencyId: "VY", train: "605", routeId: "no-such-route" });
  eq(vyFallback?.tier, "operator", "a VY route with no PDF falls back to the operator page");
  eq(
    vyFallback?.label,
    "Official timetable",
    "the operator-tier page is not labelled a PDF",
  );
  eq(getScheduleLabel("VY"), "Official timetable", "no url means no PDF claim");
  eq(
    getScheduleLabel("VY", "https://example.com/t.pdf?v=2"),
    "Official timetable (PDF)",
    "a query string does not hide the extension",
  );
  eq(
    getScheduleLabel("VY", "https://example.com/pdfviewer"),
    "Official timetable",
    "\"pdf\" inside a path is not a PDF",
  );
}

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

// ── Trenitalia: a per-train page addressed by station code and departure day ──
// The operator's own URL for ICN 1962 out of Siracusa on 8 Sep 2026 is
// cercaTreno.jsp?treno=1962&origine=S12349&datapartenza=1788818400000.
{
  const url = buildScheduleUrl({
    agencyId: "FS",
    train: "ICN 1962",
    routeId: "icn_ICN_1962",
    originCode: "S12349",
  });
  check(
    url?.startsWith(
      "https://www.viaggiatreno.it/infomobilitamobile/pages/cercaTreno/cercaTreno.jsp?treno=1962&origine=S12349&datapartenza=",
    ),
    `FS builds the operator's per-train URL (got ${url})`,
  );
  // datapartenza is midnight of the current day in Rome, to the millisecond:
  // Viaggiatreno keys the train on its departure day, and the railway day is
  // the operator's local one.
  const ms = Number(new URL(url).searchParams.get("datapartenza"));
  check(Number.isInteger(ms), "FS datapartenza is an integer epoch");
  const rome = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  eq(rome, "00:00:00", "FS datapartenza lands exactly on Rome midnight");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());
  const linked = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date(ms));
  eq(linked, today, "FS datapartenza is today's railway day in Rome");
}
// The origin code is not derivable from a station name, so without one the link
// must fall back rather than open cercaTreno with no train to find. This is the
// state before the first scrape carrying station codes, and it is what the
// Back-on-Track FS rows ("IC Notte 752") stay on — the feed has no such train.
eq(
  buildScheduleCandidate({ agencyId: "FS", train: "ICN 1962", routeId: "icn_ICN_1962" })?.tier,
  "operator",
  "FS without an origin code falls back to the Intercity Notte page",
);
eq(
  buildScheduleCandidate({ agencyId: "FS", train: "IC Notte 752", routeId: "86" })?.tier,
  "operator",
  "a Back-on-Track FS row falls back to the Intercity Notte page",
);
// Each direction carries its own train and its own origin: ICN 1962 leaves
// Siracusa, ICN 1963 leaves Milano Centrale.
{
  const back = buildScheduleUrl({
    agencyId: "FS",
    train: "ICN 1963",
    routeId: "icn_ICN_1962",
    originCode: "S01700",
  });
  check(
    back?.includes("treno=1963") && back?.includes("origine=S01700"),
    `the return direction uses its own train and origin (got ${back})`,
  );
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
        ["{train}", "{date}", "{dateMs}", "{originCode}"].includes(ph),
        `${id}: unknown placeholder ${ph} in scheduleUrlTemplate`,
      );
    }
  }
  if (cfg.scheduleUrlTemplate?.includes("{dateMs}")) {
    check(
      Boolean(cfg.scheduleTimeZone),
      `${id}: a {dateMs} template needs scheduleTimeZone — the railway day is the operator's local one`,
    );
  }
  if (cfg.scheduleTimeZone) {
    let valid = true;
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: cfg.scheduleTimeZone });
    } catch {
      valid = false;
    }
    check(valid, `${id}: "${cfg.scheduleTimeZone}" is not a usable IANA time zone`);
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

// ── The merge carries the operator's station code onto the row ─────────────
// Without this the FS template can never fire on either surface. Guards the
// shape contract with scripts/adapters/viaggiatreno.mjs: stations[0].code.
{
  const viewMap = {
    r1: {
      route_id: "r1",
      agency_id: "FS",
      trip_short_name_0: "ICN 1962",
      trip_short_name_1: "ICN 1963",
      origin_trip_0: "Siracusa",
      destination_trip_0: "Milano Centrale",
      is_active: "Y",
    },
  };
  const trips = {
    "ICN 1962": { route_id: "r1", trip_short_name: "ICN 1962", direction_id: 0, is_active: "Y" },
  };
  const operatorTrains = {
    italian: {
      "ICN 1962": { stations: [{ name: "Siracusa", code: "S12349" }, { name: "Milano Centrale" }] },
      "ICN 1963": { stations: [{ name: "Milano Centrale", code: "S01700" }, { name: "Siracusa" }] },
      // A train whose stations carry no code must not stamp anything.
      "ICN 999": { stations: [{ name: "Roma Termini" }] },
    },
  };
  const built = buildInitialData({ stops: [], viewMap, trips, operatorTrains });
  const row = built.viewMap.r1;
  eq(row?.schedule_origin_code_0, "S12349", "the merge stamps direction 0's origin code");
  eq(row?.schedule_origin_code_1, "S01700", "…and direction 1's, from its own train");

  const noCodes = buildInitialData({
    stops: [],
    viewMap,
    trips,
    operatorTrains: { italian: { "ICN 1962": { stations: [{ name: "Siracusa" }] } } },
  });
  check(
    noCodes.viewMap.r1?.schedule_origin_code_0 === undefined,
    "a feed without station codes stamps nothing rather than a broken value",
  );
}

// ── A station code belongs to one operator's train, not to a number ───────
// The stamp used to flatten every source's trains into one map keyed by bare
// train number, so adding Norway put SJ Nord's quay id for Trondheim S onto
// European Sleeper's ES 475 row — the two operators both run a 475. Nothing
// rendered wrong only because no Vy/SJ Nord template names {originCode}, which
// is the worst kind of latent fault: correct-looking until someone adds one.
{
  const registry = [
    {
      id: "europeansleeper",
      enabled: true,
      output: "europeansleeper-trains.json",
      synthetic: { idPrefix: "es_", agency: { from: "fixed", value: "ES" } },
      enrich: { strategy: "trainsByNumber", agencyIds: ["ES"] },
    },
    {
      id: "entur-sjn",
      enabled: true,
      output: "entur-sjn-trains.json",
      synthetic: { idPrefix: "entur_sjn_", agency: { from: "fixed", value: "SJN" } },
      enrich: { strategy: "trainsByNumber", agencyIds: ["VY", "SJN", "GA"] },
    },
  ];
  const viewMap = {
    es: {
      route_id: "es",
      agency_id: "ES",
      trip_short_name_0: "474",
      trip_short_name_1: "475",
      is_active: "Y",
    },
    no: {
      route_id: "no",
      agency_id: "SJN",
      trip_short_name_0: "475",
      trip_short_name_1: "476",
      is_active: "Y",
    },
  };
  const trips = {
    474: { route_id: "es", trip_short_name: "474", direction_id: 0, is_active: "Y" },
    475: { route_id: "no", trip_short_name: "475", direction_id: 0, is_active: "Y" },
  };
  const operatorTrains = {
    europeansleeper: {
      474: { stations: [{ name: "Bruxelles-Midi", code: "ES-BRU" }] },
      475: { stations: [{ name: "Praha hl.n.", code: "ES-PRG" }] },
    },
    "entur-sjn": {
      475: { stations: [{ name: "Trondheim S", code: "NSR:Quay:1080" }] },
      476: { stations: [{ name: "Bodø", code: "NSR:Quay:828" }] },
    },
  };
  const built = buildInitialData({ stops: [], viewMap, trips, operatorTrains, registry });
  eq(built.viewMap.es?.schedule_origin_code_0, "ES-BRU", "an ES row takes ES's code");
  eq(
    built.viewMap.es?.schedule_origin_code_1,
    "ES-PRG",
    "…and ES's 475, not SJ Nord's quay id for the same number",
  );
  eq(built.viewMap.no?.schedule_origin_code_0, "NSR:Quay:1080", "the SJN row takes Entur's");
  eq(built.viewMap.no?.schedule_origin_code_1, "NSR:Quay:828", "…on both its directions");
}

// ── Tier order is the contract the resolver relies on ──────────────────────
eq(SCHEDULE_TIERS.join(","), "train-page,route,train,country,operator", "tier order is most-specific first");

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
  check(tiers.route >= 5, `per-route links cover VIA/SJN (got ${tiers.route || 0})`);

  // The country tier only works because the merge stamps endpoint countries.
  const stamped = rows.filter((r) => r.origin_country_0 || r.destination_country_0);
  check(
    stamped.length >= 150,
    `the merge stamps endpoint countries on the Back-on-Track rows (got ${stamped.length})`,
  );
}

// ─── A per-train page beats a per-route one, because a route has two ends ───
// Ukrainian Railways numbers a train 099 but reaches its timetable at
// ?ntrain=105997&by_id=1 — an internal id not derivable from the number. 099
// and 100 are opposite directions of route 174 and have separate pages, so
// schedulePages[routeId], which is one page for a whole line, cannot express
// them.
{
  const dir0 = buildScheduleCandidate({ agencyId: "UZ", train: "099", routeId: "174" });
  const dir1 = buildScheduleCandidate({ agencyId: "UZ", train: "100", routeId: "174" });
  eq(dir0?.tier, "train-page", "UZ 099 resolves at the per-train tier");
  eq(dir1?.tier, "train-page", "UZ 100 resolves at the per-train tier");
  check(
    dir0?.url?.includes("ntrain=105997") && dir0.url.includes("by_id=1"),
    `UZ 099 links to its own train page (got ${dir0?.url})`,
  );
  check(
    dir1?.url?.includes("ntrain=106002"),
    `UZ 100 links to its own train page (got ${dir1?.url})`,
  );
  check(
    dir0?.url !== dir1?.url,
    "the two directions of one route must not share a timetable link",
  );

  // Nothing else moves: a UZ train with no recorded id keeps the number search,
  // and a route with a schedulePages entry keeps its route page.
  const plain = buildScheduleCandidate({ agencyId: "UZ", train: "051", routeId: "140" });
  eq(plain?.tier, "train", "a UZ train with no recorded id keeps the number search");
  const perRoute = buildScheduleCandidate({ agencyId: "UZ", train: "40149", routeId: "60" });
  eq(perRoute?.tier, "route", "a route with its own page keeps it");
}

if (problems.length) {
  console.error(`verify-schedule-links: ${problems.length} problem(s)`);
  for (const p of problems) console.error(" -", p);
  process.exit(1);
}
console.log("verify-schedule-links: OK");
