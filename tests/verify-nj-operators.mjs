// tests/verify-nj-operators.mjs
// Partner EuroNights on nightjet.com are their carrier's, not ÖBB's.
//
// nightjet.com sells ÖBB's Nightjets and its partners' EuroNights from one
// shop, and from October 2026 European Sleeper's trains too. Before this, every
// train it listed became an ÖBB row priced by nightjet.com: München–Przemyśl
// read "ÖBB" (nightjet.com itself says "Operated by Polnische Bahn PKP"),
// booked through ÖBB's shop, quoted nightjet.com's figures as fares; ES 453
// appeared twice; and nightjet.com's Budapest–Stuttgart "EN 442" deleted ČD's
// Humenné–Praha EN 442 and drew its own line onto it.
//
// Covered here:
//   - the carrier mapping (scripts/lib/operator-agencies.mjs) and its
//     validation, against the committed registry config;
//   - the same-train test (src/lib/sameTrain.mjs);
//   - how the adapter assigns carriers, hands trains to another source, and
//     leaves partner trains out of the fare pass and the weekly probe;
//   - the build: carrier agency on the row, no joint bot_agency_id, an empty
//     pricing record, and a namesake Back-on-Track row kept;
//   - the enrichment's requireSameTrain;
//   - the committed payload.
//
// Raw node, no network. Run: npm run verify-nj-operators
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agencyForLineName,
  agencyForOperatorText,
  carrierInAgencyId,
  compileOperatorAgencies,
  foldOperatorWords,
  publishedElsewhere,
  readOperatorText,
  validateOperatorAgencies,
} from "../scripts/lib/operator-agencies.mjs";
import { validateRegistry } from "../scripts/lib/registry.mjs";
import {
  assignTrainAgencies,
  backOnTrackAgencies,
  priceTrains,
  selectPartnerNumbers,
} from "../scripts/adapters/nightjet.mjs";
import { probeCandidates } from "../scripts/adapters/nightjet-offers.mjs";
import { njPricesTrain } from "../scripts/lib/nj-fares.mjs";
import { sameTrainAsRow } from "../src/lib/sameTrain.mjs";
import { enrichViewMap } from "../scripts/lib/enrich-view-map.mjs";
import { buildInitialData, stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";
import { resolvePricing } from "../src/lib/pricingResolve.mjs";
import { resolveOperatorComponents } from "../src/lib/operatorAgencies.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const REGISTRY = readJson("data/sources/registry.json");
const NJ_ENTRY = REGISTRY.find((e) => e.id === "nightjet");
const CONFIG = NJ_ENTRY.params.operatorAgencies;
const COMPILED = compileOperatorAgencies(CONFIG);

const station = (name, id = null) => ({ name, ...(id ? { id } : {}), location: { latitude: 48, longitude: 16 } });
const train = (operator, names, extra = {}) => ({ operator, stations: names.map((n) => station(n)), ...extra });

// ─── The mapping ─────────────────────────────────────────────────────────────

await check("operator text: nightjet.com's sentence names the carrier, in either language", () => {
  const agency = (text) => agencyForOperatorText(text, COMPILED);
  assert.deepEqual(agency("Operated by Polnische Bahn PKP"), { status: "matched", agency: "PKP", all: ["PKP"] });
  assert.equal(agency("Betrieben von PKP Intercity").agency, "PKP");
  assert.equal(agency("Operated by MÁV-START").agency, "MÁV");
  assert.equal(agency("Ungarische Staatsbahnen").agency, "MÁV", "a German stem");
  assert.equal(agency("Operated by Tschechische Bahn ČD").agency, "ČD");
  assert.equal(agency("Operated by Kroatische Bahn HŽPP").agency, "HŽPP");
  assert.equal(agency("Operated by European Sleeper").agency, "ES");
  // Folding: an NFD-composed "MÁV" is the same word.
  assert.equal(agency("Operated by MÁV").agency, "MÁV");
  assert.deepEqual(foldOperatorWords("Tschechische Bahn ČD"), ["tschechische", "bahn", "cd"]);
  // ÖBB named beside a partner is still the partner's train.
  assert.equal(agency("ÖBB und Polnische Bahn PKP").status, "matched");
  assert.equal(agency("ÖBB und Polnische Bahn PKP").agency, "PKP");
  // Two partners: the first named, flagged.
  assert.deepEqual(agency("PKP und ČD"), { status: "ambiguous", agency: "PKP", all: ["PKP", "ČD"] });
  assert.deepEqual(agency("Österreichische Bundesbahnen"), { status: "home", agency: "ÖBB", all: ["ÖBB"] });
  // A carrier the mapping does not list names no one rather than a neighbour:
  // "Slowenische" must not read as "Slowakisch*".
  assert.equal(agency("Operated by Slowenische Bahn SŽ").status, "unknown");
  assert.equal(agency("").status, "missing");
  assert.equal(agency(null).status, "missing");
  // Whole words only: "cd" inside another word is not ČD.
  assert.equal(agency("Operated by Acdc Rail").status, "unknown");
});

await check("readOperatorText: a string or a localised object, trimmed and NFC", () => {
  assert.equal(readOperatorText("  Operated by Polnische Bahn PKP "), "Operated by Polnische Bahn PKP");
  assert.equal(readOperatorText({ de: "Betrieben von PKP", en: "Operated by PKP" }), "Operated by PKP");
  assert.equal(readOperatorText({ fr: "Exploité par PKP" }), "Exploité par PKP");
  assert.equal(readOperatorText("MÁV"), "MÁV");
  assert.equal(readOperatorText({}), null);
  assert.equal(readOperatorText("   "), null);
  assert.equal(readOperatorText(42), null);
});

await check("the committed mapping validates, and each rule rejects what it should", () => {
  assert.deepEqual(validateOperatorAgencies(CONFIG), []);
  const base = () => structuredClone(CONFIG);
  const rejects = (mutate, pattern) => {
    const config = base();
    mutate(config);
    const errors = validateOperatorAgencies(config);
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in ${JSON.stringify(errors)}`);
  };
  rejects((c) => { c.carriers[0].agency = "PKP/ČD"; }, /without "\/"/);
  rejects((c) => { c.carriers[0].match.push("Slo*"); }, /at least 4 letters/);
  rejects((c) => { c.carriers[0].match.push("Pol*ish"); }, /only allowed at the end/);
  rejects((c) => { c.carriers[0].match.push("Polskie Koleje*"); }, /one word/);
  rejects((c) => { c.carriers[0].match.push("–"); }, /folds to no word/);
  rejects((c) => { c.carriers[0].extra = true; }, /unknown key "extra"/);
  rejects((c) => { c.extra = true; }, /unknown key "extra"/);
  rejects((c) => { c.carriers[1].match.push("PKP"); }, /also belongs to PKP/);
  rejects((c) => { c.home = "SBB"; }, /must also be listed as a carrier/);
  rejects((c) => { c.carriers.push({ agency: "SŽ", match: ["Polni*"] }); }, /also matches PKP/);
  rejects((c) => { c.carriers[0].lines = ["E S"]; }, /1–6 letters/);
  rejects((c) => { c.carriers[0].lines = ["ES"]; }, /"ES" also belongs to/);
  rejects((c) => {
    c.carriers.find((x) => x.agency === c.home).publishedBy = "europeansleeper";
  }, /home carrier/);
  rejects((c) => { c.carriers.push({ agency: "PKP", match: ["Polen"] }); }, /listed twice/);
});

await check("validateRegistry: a carrier handed to another source names a real one", () => {
  assert.deepEqual(validateRegistry(REGISTRY), []);
  const broken = structuredClone(REGISTRY);
  const es = broken.find((e) => e.id === "nightjet").params.operatorAgencies.carriers.find((c) => c.agency === "ES");
  es.publishedBy = "europeansleepr";
  assert.ok(validateRegistry(broken).some((e) => /publishedBy unknown source "europeansleepr"/.test(e)));
  es.publishedBy = "nightjet";
  assert.ok(validateRegistry(broken).some((e) => /publishedBy the source itself/.test(e)));
  const typo = structuredClone(REGISTRY);
  typo.find((e) => e.id === "nightjet").enrich.requireSametrain = true;
  assert.ok(validateRegistry(typo).some((e) => /unknown enrich option\(s\): requireSametrain/.test(e)));
});

await check("line prefixes, Back-on-Track ids and publishedBy", () => {
  assert.equal(agencyForLineName("ES 452", COMPILED), "ES");
  assert.equal(agencyForLineName("es 452", COMPILED), "ES");
  assert.equal(agencyForLineName("EN 40417", COMPILED), null);
  assert.equal(agencyForLineName("", COMPILED), null);
  assert.equal(publishedElsewhere("ES", COMPILED), "europeansleeper");
  assert.equal(publishedElsewhere("PKP", COMPILED), null);
  // One carrier out of a joint id, never the compound (it books by link
  // quality, which sends a HŽPP train to ÖBB's shop).
  assert.equal(carrierInAgencyId("HŽPP/ÖBB", COMPILED), "HŽPP");
  assert.equal(carrierInAgencyId("ÖBB/MÁV", COMPILED), "MÁV");
  assert.equal(carrierInAgencyId("PKP/ČD", COMPILED), "PKP");
  // Back-on-Track saying ÖBB alone runs it is an answer, not a missing one.
  assert.equal(carrierInAgencyId("ÖBB", COMPILED), "ÖBB");
  assert.equal(carrierInAgencyId("SJ", COMPILED), null);
  assert.equal(carrierInAgencyId(null, COMPILED), null);
});

// ─── Same train, or a namesake ───────────────────────────────────────────────

const ROW_6 = {
  route_id: 6,
  agency_id: "ČD",
  trip_short_name_0: "EN 442",
  trip_short_name_1: "EN 443",
  origin_trip_0: "Humenné",
  destination_trip_0: "Praha hl.n.",
  origin_trip_1: "Praha hl.n.",
  destination_trip_1: "Humenné",
  is_active: "Y",
};
const NJ_EN_442 = train("EuroNight", ["Budapest-Keleti", "Wien Hbf", "Stuttgart Hbf"]);
const ROW_113 = {
  route_id: 113,
  agency_id: "PKP",
  trip_short_name_0: "EN 1276",
  trip_short_name_1: "EN 1277",
  origin_trip_0: "Rijeka",
  destination_trip_0: "Warszawa Wschodnia",
  origin_trip_1: "Warszawa Wschodnia",
  destination_trip_1: "Rijeka",
  is_active: "Y",
};
const NJ_EN_1277 = train("EuroNight", ["Warschau Wschodnia", "Wien Hbf", "Rijeka"]);

await check("sameTrainAsRow: one shared end city makes the same train; none, a namesake", () => {
  assert.equal(sameTrainAsRow(ROW_6, NJ_EN_442), false, "Budapest–Stuttgart is not Humenné–Praha");
  assert.equal(sameTrainAsRow(ROW_113, NJ_EN_1277), true, "German and Polish spellings of one city");
  const portion = { ...ROW_113, destination_trip_0: "Zürich HB", origin_trip_1: "Zürich HB", origin_trip_0: "Budapest-Keleti", destination_trip_1: "Budapest-Keleti" };
  assert.equal(sameTrainAsRow(portion, train("EuroNight", ["Budapest-Keleti", "Sargans"])), true, "a portion shares one end");
  // Nothing to compare is not proof of a different train.
  assert.equal(sameTrainAsRow({ trip_short_name_0: "EN 1" }, NJ_EN_442), true);
  assert.equal(sameTrainAsRow(ROW_6, { stations: [] }), true);
});

await check("sameTrainAsRow: every number nightjet.com shares with a committed Back-on-Track row", () => {
  // The rule was chosen on this data; pin what it does to it.
  const bot = readJson("public/data/scraped/backontrack-view_ontd_map.json").data;
  const nj = readJson("public/data/scraped/nightjet-trains.json").data.trains;
  const different = [];
  let same = 0;
  for (const [key, row] of Object.entries(bot)) {
    if (key.startsWith("nj_standalone_")) continue;
    for (const d of [0, 1]) {
      const name = String(row[`trip_short_name_${d}`] ?? "").trim();
      if (!nj[name]) continue;
      if (sameTrainAsRow(row, nj[name])) same++;
      else different.push(`${key}:${name}`);
    }
  }
  assert.ok(same > 30, `${same} same-train matches`);
  assert.deepEqual(different.sort(), ["6:EN 442", "6:EN 443"], "only ČD's Humenné–Praha is a namesake");
});

// ─── The adapter ─────────────────────────────────────────────────────────────

await check("assignTrainAgencies: text, then prefix, then last night, then Back-on-Track, then home", () => {
  const trains = {
    "NJ 402": train("Nightjet", ["Zürich HB", "Amsterdam Centraal"]),
    "NJ 40421": train("Nightjet", ["Amsterdam Centraal", "Wien Hbf"], { operatorText: "Operated by Polnische Bahn PKP" }),
    "EN 40417": train("EuroNight", ["Przemysl Gl.", "München Hbf"], { operatorText: "Operated by Polnische Bahn PKP" }),
    "EN 40459": train("EuroNight", ["Zürich HB", "Prag Hbf"], { operatorText: "Operated by ÖBB und Tschechische Bahn ČD" }),
    "ES 452": train("EuroNight", ["Prag Hbf", "Brüssel Midi"]),
    "EN 40237": train("EuroNight", ["Stuttgart Hbf", "Zagreb Glavni Kolod."]),
    "EN 40457": train("EuroNight", ["Berlin Hbf", "Budapest-Keleti"], { operatorText: "Operated by Slowenische Bahn SŽ" }),
    "EN 442": train("EuroNight", ["Budapest-Keleti", "Stuttgart Hbf"]),
    "EN 415": train("EuroNight", ["Zagreb Glavni Kolod.", "Stuttgart Hbf"]),
    // nightjet.com naming only ÖBB on a partner-listed train: taken, never silently.
    "EN 1272": train("EuroNight", ["Split", "Wien Hbf"], { operatorText: "Operated by Österreichische Bundesbahnen" }),
    "EN 40465": train("EuroNight", ["Zürich HB", "Zagreb Glavni Kolod."], { operatorText: "Operated by ÖBB" }),
    // "Nightjet" is the shop's brand, not a carrier: it names no one.
    "EN 40414": train("EuroNight", ["Zagreb Glavni Kolod.", "Zürich HB"], { operatorText: "Nightjet-Partnerzug" }),
  };
  const previous = {
    "EN 40237": { agency_id: "HŽPP", agencyFrom: "operator", operatorText: "Operated by Kroatische Bahn HŽPP" },
    "EN 40457": { agency_id: "MÁV", agencyFrom: "operator" },
  };
  const botAgencies = backOnTrackAgencies(
    {
      57: { route_id: 57, agency_id: "HŽPP/ÖBB", trip_short_name_0: "EN 40237", origin_trip_0: "Stuttgart Hbf", destination_trip_0: "Zagreb Glavni Kolod." },
      58: { route_id: 58, agency_id: "MÁV", trip_short_name_0: "EN 40457", origin_trip_0: "Berlin Hbf", destination_trip_0: "Budapest-Keleti" },
      6: ROW_6,
      nj_standalone_EN_415: { route_id: "nj_standalone_EN_415", agency_id: "ÖBB", trip_short_name_0: "EN 415" },
      117: {
        route_id: 117,
        agency_id: "HŽPP/ÖBB",
        trip_short_name_0: "EN 40414",
        trip_short_name_1: "EN 40465",
        origin_trip_0: "Zagreb Glavni Kolod.",
        destination_trip_0: "Zürich HB",
      },
    },
    "nj_standalone_",
    trains,
  );
  assert.equal(botAgencies.has("EN 442"), false, "a namesake row lends no carrier");
  assert.equal(botAgencies.has("EN 415"), false, "our own leftover row is not Back-on-Track's word");
  const report = assignTrainAgencies(trains, { compiled: COMPILED, previous, botAgencies });
  const got = Object.fromEntries(Object.entries(trains).map(([k, t]) => [k, `${t.agency_id}/${t.agencyFrom}`]));
  assert.deepEqual(got, {
    "NJ 402": "ÖBB/home",
    "NJ 40421": "ÖBB/home", // a Nightjet stays ÖBB's whatever its text says…
    "EN 40417": "PKP/operator",
    "EN 40459": "ČD/operator",
    "ES 452": "ES/line",
    "EN 40237": "HŽPP/operator", // no text tonight: last night's stated carrier
    "EN 40457": "MÁV/bot", // text naming no listed carrier is not carried over
    "EN 442": "ÖBB/home",
    "EN 415": "ÖBB/home",
    "EN 1272": "ÖBB/operator",
    "EN 40465": "ÖBB/operator",
    "EN 40414": "HŽPP/bot",
  });
  assert.ok(report.notes.some((n) => n.startsWith("NJ 40421 is a Nightjet")), "…and the oddity is logged");
  assert.ok(report.problems.some((p) => p.startsWith("EN 40457: operator text \"Operated by Slowenische Bahn SŽ\"")));
  assert.ok(report.problems.some((p) => p.startsWith("EN 442: no operator text and no Back-on-Track carrier")));
  assert.ok(report.notes.some((n) => n.startsWith("EN 1272: partner train whose operator text names only ÖBB")));
  assert.ok(
    report.problems.some((p) => p.startsWith("EN 40465: partner train whose operator text names only ÖBB") && p.endsWith("Back-on-Track says HŽPP; kept ÖBB")),
    "ÖBB against Back-on-Track's HŽPP is a warning",
  );
  assert.ok(report.problems.some((p) => p.startsWith('EN 40414: operator text "Nightjet-Partnerzug" names no carrier')));
  assert.equal(report.problems.length, 5, report.problems.join("; "));
  assert.equal(trains["EN 40237"].operatorText, "Operated by Kroatische Bahn HŽPP");
});

await check("the fare pass and the probe leave partner trains to their carrier", async () => {
  assert.equal(njPricesTrain({ operator: "Nightjet" }), true);
  assert.equal(njPricesTrain({ operator: "EuroNight" }), false);
  assert.equal(njPricesTrain({ operator: "EuroNight", agency_id: "PKP", agencyFrom: "operator" }), false);
  // A partner-listed train nightjet.com (or Back-on-Track) says ÖBB runs is ÖBB's train…
  assert.equal(njPricesTrain({ operator: "EuroNight", agency_id: "ÖBB", agencyFrom: "operator" }), true);
  assert.equal(njPricesTrain({ operator: "EuroNight", agency_id: "ÖBB", agencyFrom: "bot" }), true);
  // …one that fell back to ÖBB for want of an answer is nobody's to price.
  assert.equal(njPricesTrain({ operator: "EuroNight", agency_id: "ÖBB", agencyFrom: "home" }), false);
  assert.equal(njPricesTrain({ operator: "EuroNight", agency_id: "SBB", agencyFrom: "operator" }, "SBB"), true, "home is the source's");
  assert.equal(njPricesTrain(null), false);

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-operators-"));
  try {
    const ids = { stations: [{ id: "8503000", name: "Zürich HB" }, { id: "8400058", name: "Amsterdam Centraal" }] };
    const partnerIds = { stations: [{ id: "5100062", name: "Przemysl Gl." }, { id: "8000261", name: "München Hbf" }] };
    const calendar = { version: 1, currency: "EUR", nights: { "2026-10-20": { classes: { couchette: 44.9 }, checkedAt: "2026-10-14" } } };
    fs.mkdirSync(path.join(rootDir, "public/data/scraped"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "public/data/scraped/nightjet-trains.json"),
      JSON.stringify({
        data: {
          trains: {
            "NJ 402": { operator: "Nightjet", ...ids, fare: { fromPrice: 59.9 } },
            "EN 40417": { operator: "EuroNight", ...partnerIds, fare: { fromPrice: 44.9 }, fareCalendar: calendar },
          },
        },
      }),
    );
    const results = {
      "NJ 402": { operator: "Nightjet", ...structuredClone(ids) },
      "EN 40417": { operator: "EuroNight", ...structuredClone(partnerIds) },
    };
    const urls = [];
    const entry = { output: "nightjet-trains.json", params: { fares: { enabled: true, days: 42, requestsPerRun: 720 } } };
    await priceTrains(results, entry, {
      today: "2026-10-15",
      rootDir,
      // A refusal ends the pass at its first request: enough to see which
      // train the planner asked about, with nothing to wait for.
      fetch: async (url) => {
        urls.push(String(url));
        return new Response("blocked", { status: 403, headers: { "cf-mitigated": "challenge" } });
      },
    });
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("NJ%20402") || urls[0].includes("NJ 402"), urls[0]);
    assert.equal(results["EN 40417"].fare, null, "`fare: null` says the source does not price it");
    assert.equal("fareCalendar" in results["EN 40417"], false, "last night's calendar is not carried");

    // Partner trains only: not one request. One whose carrier fell back to
    // ÖBB carries no fare key at all, so its ÖBB row keeps ÖBB's fare model
    // (stampOfficialFares stamps the empty record only on `fare: null`).
    const partnersOnly = {
      "EN 40417": { operator: "EuroNight", ...structuredClone(partnerIds) },
      "EN 477": { operator: "EuroNight", agency_id: "ÖBB", agencyFrom: "home", fare: { fromPrice: 1 }, ...structuredClone(partnerIds) },
    };
    urls.length = 0;
    await priceTrains(partnersOnly, entry, { today: "2026-10-15", rootDir, fetch: async (url) => { urls.push(url); return new Response("[]"); } });
    assert.equal(urls.length, 0);
    assert.equal(partnersOnly["EN 40417"].fare, null);
    assert.equal("fare" in partnersOnly["EN 477"], false);

    // The weekly probe: a proposal for a partner would put nightjet.com's
    // figure back on the row through prices.json.
    const candidates = probeCandidates(
      { output: "nightjet-trains.json", params: { operatorAgencies: CONFIG } },
      { rootDir, seenRoutes: new Set(["nj_standalone_NJ_402", "nj_standalone_EN_40417"]) },
    );
    assert.deepEqual(candidates.map((c) => c.lineName), ["NJ 402"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

await check("selectPartnerNumbers: another source's trains leave before the cap, and the cap says what it cut", () => {
  // 14 October: 22 EuroNights and three ES trains filled all 25 slots, and
  // ES 474 — the 26th — was cut; any new partner would have pushed a real
  // EuroNight out without a word.
  const list = [
    ...Array.from({ length: 22 }, (_, i) => `EN ${40000 + i}`),
    "ES 452",
    "ES 453",
    "ES 475",
    "ES 474",
    "EN 50999",
  ];
  const got = selectPartnerNumbers(list, { compiled: COMPILED, max: 25 });
  assert.deepEqual(got.handedOver, { europeansleeper: ["ES 452", "ES 453", "ES 475", "ES 474"] });
  assert.equal(got.kept.length, 23);
  assert.ok(got.kept.includes("EN 50999"), "the train behind the ES block is fetched");
  assert.deepEqual(got.cut, []);
  const tight = selectPartnerNumbers(list, { compiled: COMPILED, max: 20 });
  assert.deepEqual(tight.cut, ["EN 40020", "EN 40021", "EN 50999"]);
  assert.deepEqual(selectPartnerNumbers(["EN 1", "EN 1"], { compiled: null }).kept, ["EN 1"], "deduplicated");
  assert.deepEqual(selectPartnerNumbers(["ES 452"], { compiled: null }).kept, ["ES 452"], "no mapping, no hand-over");
});

// ─── The build ───────────────────────────────────────────────────────────────

const njEntry = { ...structuredClone(NJ_ENTRY), probe: undefined };
const at = (name, lat, lon) => ({ name, location: { latitude: lat, longitude: lon } });
const world = () => ({
  stops: [
    { stop_id: "Humenné", stop_name: "Humenné", stop_lat: 48.93, stop_lon: 21.9 },
    { stop_id: "Praha hl.n.", stop_name: "Praha hl.n.", stop_lat: 50.08, stop_lon: 14.43 },
    { stop_id: "München Hbf", stop_name: "München Hbf", stop_lat: 48.14, stop_lon: 11.56 },
    { stop_id: "Przemyśl Główny", stop_name: "Przemyśl Główny", stop_lat: 49.78, stop_lon: 22.77 },
  ],
  viewMap: {
    6: { ...ROW_6 },
    118: {
      route_id: 118,
      agency_id: "PKP/ČD",
      trip_short_name_0: "EN 40416",
      trip_short_name_1: "EN 40417",
      origin_trip_0: "München Hbf",
      destination_trip_0: "Przemyśl Główny",
      origin_trip_1: "Przemyśl Główny",
      destination_trip_1: "München Hbf",
      is_active: "Y",
    },
  },
  trips: {
    "EN 442": { route_id: 6, agency_id: "ČD", trip_short_name: "EN 442" },
    "EN 40416": { route_id: 118, agency_id: "PKP/ČD", trip_short_name: "EN 40416" },
  },
});
const njTrains = () => ({
  "EN 40416": {
    lineName: "EN 40416",
    operator: "EuroNight",
    agency_id: "PKP",
    agencyFrom: "operator",
    fare: null,
    polyline: "p40416",
    stations: [at("München Hbf", 48.14, 11.56), at("Przemyśl Główny", 49.78, 22.77)],
  },
  "EN 40417": {
    lineName: "EN 40417",
    operator: "EuroNight",
    agency_id: "PKP",
    agencyFrom: "operator",
    fare: null,
    polyline: "p40417",
    stations: [at("Przemyśl Główny", 49.78, 22.77), at("München Hbf", 48.14, 11.56)],
  },
  "EN 442": {
    lineName: "EN 442",
    operator: "EuroNight",
    agency_id: "ÖBB",
    agencyFrom: "home",
    polyline: "p442",
    stations: [at("Budapest-Keleti", 47.5, 19.08), at("Stuttgart Hbf", 48.78, 9.18)],
  },
});
const build = () => {
  const { stops, viewMap, trips } = world();
  return buildInitialData({
    stops,
    viewMap,
    trips,
    operatorTrains: { nightjet: njTrains() },
    registry: [njEntry],
    seenIndex: null,
    routePrices: {},
  }).viewMap;
};

await check("build: a partner row is its carrier's, with one operating carrier and no fare model", () => {
  const vm = build();
  const row = vm.nj_standalone_EN_40416;
  assert.ok(row, Object.keys(vm).join(", "));
  assert.equal(vm[118], undefined, "Back-on-Track's row for the same train is replaced");
  assert.equal(row.agency_id, "PKP");
  // The panel, the schedule link and the planner read bot_agency_id first:
  // Back-on-Track's "PKP/ČD" would contradict nightjet.com, and no field at
  // all let the panel fall through to the trains file's brand "EuroNight".
  assert.equal(row.bot_agency_id, "PKP");
  assert.deepEqual(row.pricing, { type: null, currency: null, fromPrice: null, source: "nightjet" });
  assert.equal(resolvePricing(row, { PKP: { type: "fixed", note: "Domestic tariff" } }), row.pricing, "PKP's domestic default never reached");
  assert.equal(row.fare_0, undefined);
  assert.equal(row.fare_calendar_0, undefined);
});

await check("build: the row takes its carrier from whichever direction states one", () => {
  const { stops, viewMap, trips } = world();
  const trains = njTrains();
  // Tonight the outbound's answer named no carrier and it fell back to ÖBB —
  // the shape the adapter writes, agency_id and all; the return's named PKP.
  trains["EN 40416"].agency_id = "ÖBB";
  trains["EN 40416"].agencyFrom = "home";
  delete trains["EN 40416"].fare;
  const vm = buildInitialData({ stops, viewMap, trips, operatorTrains: { nightjet: trains }, registry: [njEntry], seenIndex: null, routePrices: {} }).viewMap;
  assert.equal(vm.nj_standalone_EN_40416.trip_short_name_1, "EN 40417");
  assert.equal(vm.nj_standalone_EN_40416.agency_id, "PKP", "not the outbound's ÖBB fallback");
  assert.equal(vm.nj_standalone_EN_40416.bot_agency_id, "PKP");
  assert.equal(vm.nj_standalone_EN_40416.pricing?.type, null, "one refused direction and none priced: no fare model");
});

await check("build: a Back-on-Track row that only shares the number is kept, and the namesake gets no row", () => {
  const vm = build();
  assert.ok(vm[6], "ČD's Humenné–Praha EN 442 survives");
  assert.equal(vm[6].agency_id, "ČD");
  assert.equal(vm.nj_standalone_EN_442, undefined, "no second EN 442 on the map");
});

await check("build: a source that names no carrier keeps Back-on-Track's joint attribution", () => {
  const { stops, viewMap, trips } = world();
  const trains = njTrains();
  for (const t of Object.values(trains)) {
    delete t.agency_id;
    delete t.agencyFrom;
    delete t.fare;
  }
  const vm = buildInitialData({ stops, viewMap, trips, operatorTrains: { nightjet: trains }, registry: [njEntry], seenIndex: null, routePrices: {} }).viewMap;
  assert.equal(vm.nj_standalone_EN_40416.agency_id, "ÖBB", "the registry fallback");
  assert.equal(vm.nj_standalone_EN_40416.bot_agency_id, "PKP/ČD");
  assert.equal(vm.nj_standalone_EN_40416.pricing, undefined, "no stamp without `fare: null`");
});

await check("stampOfficialFares: `fare: null` on a train the row names, none priced, and only then", () => {
  const registry = [{ id: "nightjet", enabled: true, official: true }];
  const rows = () => ({
    a: { route_id: "a", agency_id: "PKP", timetable_source: "nightjet", trip_short_name_0: "EN 1", trip_short_name_1: "EN 2" },
    b: { route_id: "b", agency_id: "PKP", timetable_source: "nightjet", trip_short_name_0: "EN 1", trip_short_name_1: "NJ 3" },
    c: { route_id: "c", agency_id: "ÖBB", timetable_source: "nightjet", trip_short_name_0: "NJ 4" },
    d: { route_id: "d", agency_id: "ÖBB", timetable_source: "nightjet", trip_short_name_0: "NJ 9" },
    e: { route_id: "e", agency_id: "PKP", timetable_source: "nightjet", trip_short_name_0: "EN 1", trip_short_name_1: "NJ 4" },
    f: { route_id: "f", agency_id: "ÖBB", timetable_source: "nightjet", trip_short_name_0: "EN 477" },
  });
  const trains = {
    "EN 1": { fare: null },
    "EN 2": { fare: null },
    "NJ 3": { fare: { fromPrice: 59.9, currency: "EUR", sampledAt: "2026-10-15" } },
    "NJ 4": {},
    "EN 477": { agency_id: "ÖBB", agencyFrom: "home" },
  };
  const vm = rows();
  const trips = { t: { route_id: "a" } };
  stampOfficialFares(vm, trips, { nightjet: trains }, registry);
  assert.deepEqual(vm.a.pricing, { type: null, currency: null, fromPrice: null, source: "nightjet" });
  assert.deepEqual(trips.t.pricing, vm.a.pricing, "its trips carry it too");
  assert.equal(vm.b.pricing.fromPrice, 59.9, "a priced direction still prices the row");
  assert.equal(vm.c.pricing, undefined, "a train with no fare yet is not a train the source refuses to price");
  assert.equal(vm.d.pricing, undefined, "nor is a train the file does not carry");
  assert.equal(vm.e.pricing?.type, null, "one refused train, the other unpriced: the refusal stands");
  assert.ok(vm.e.pricing, "…as a record, so the carrier's default is not reached");
  assert.equal(vm.f.pricing, undefined, "a partner whose carrier fell back to ÖBB keeps ÖBB's fare model");
});

await check("enrichment: requireSameTrain keeps a namesake's line off a Back-on-Track row", async () => {
  const run = (enrich) => {
    const viewMap = { 6: { ...ROW_6 }, 113: { ...ROW_113 } };
    const entry = { id: "nightjet", enabled: true, enrich: { strategy: "trainsByNumber", setPolyline: true, ...enrich } };
    return enrichViewMap({
      registry: [entry],
      viewMap,
      getTrains: () => ({ "EN 442": { ...NJ_EN_442, polyline: "p442" }, "EN 1277": { ...NJ_EN_1277, polyline: "p1277" } }),
    }).then(() => viewMap);
  };
  const before = await run({});
  assert.equal(before[6].nj_polyline, "p442", "the fault: Budapest–Stuttgart drawn onto Humenné–Praha");
  const after = await run({ requireSameTrain: true });
  assert.equal(after[6].nj_polyline, undefined);
  assert.equal(after[113].nj_polyline, "p1277", "the same train still gets its line");
  assert.equal(NJ_ENTRY.enrich.requireSameTrain, true, "the committed registry turns it on");
});

// ─── The committed data ──────────────────────────────────────────────────────

await check("committed data: partner trains carry one carrier, no nightjet.com price, and nothing another source publishes", () => {
  const trains = readJson("public/data/scraped/nightjet-trains.json").data.trains;
  const listed = new Set(CONFIG.carriers.map((c) => c.agency));
  let partners = 0;
  for (const [key, t] of Object.entries(trains)) {
    assert.ok(listed.has(t.agency_id), `${key} carrier ${t.agency_id}`);
    assert.equal(publishedElsewhere(t.agency_id, COMPILED), null, `${key} belongs to another source`);
    if (t.operator === "EuroNight") partners++;
    else assert.equal(t.agency_id, CONFIG.home, `${key} is ÖBB's`);
    if (njPricesTrain(t, CONFIG.home)) continue;
    assert.equal(t.fareCalendar, undefined, `${key} calendar`);
    if (t.agency_id === CONFIG.home && t.agencyFrom === "home") {
      assert.equal("fare" in t, false, `${key}: carrier unknown, row is ÖBB's — no refusal stamped`);
    } else {
      assert.equal(t.fare, null, `${key} fare`);
    }
  }
  assert.ok(partners >= 15, `${partners} partner trains`);
  assert.ok(!Object.keys(trains).some((k) => /^ES\b/.test(k)), "European Sleeper's trains are its own source's");
});

const AGENCIES = (() => {
  const raw = readJson("public/data/scraped/backontrack-agencies.json");
  const data = raw.data ?? raw;
  return Array.isArray(data) ? Object.fromEntries(data.map((a) => [a.agency_id, a])) : data;
})();

/**
 * The map panel's operator name for a synthetic row's trip, as
 * TrainDetailPanel computes it (its imports do not load in raw node, so the
 * chain is replayed here and pinned against the source below).
 */
function panelOperatorName(row, trainsFile) {
  const operatorAgencyId = row.bot_agency_id || row.agency_id;
  const components = resolveOperatorComponents({ agencyId: operatorAgencyId, agencies: AGENCIES });
  const botOperatorName = row.bot_agency_id && components.length ? components.map((c) => c.name).join(" + ") : null;
  return botOperatorName || trainsFile[row.trip_short_name_0]?.operator || null;
}

await check("the map panel names a partner train's carrier, never the brand \"EuroNight\"", () => {
  // The fault: with no bot_agency_id the panel fell through to the trains
  // file's `operator` — "EuroNight" for every partner — and München–Przemyśl
  // read "EuroNight" beside a PKP logo.
  const src = fs.readFileSync(path.join(ROOT, "src/components/TrainDetailPanel/TrainDetailPanel.js"), "utf8");
  assert.ok(
    /const botOperatorName =\s*tripRoute\?\.bot_agency_id && operatorComponents\.length/.test(src),
    "the panel's name chain is still keyed on bot_agency_id (update panelOperatorName if it moved)",
  );
  assert.ok(/botOperatorName \|\|\s*nightjetTrain\?\.operator/.test(src), "…ahead of the trains file's brand");
  const vm = readJson("public/data/published/initial-data.json").data.viewMap;
  const trains = readJson("public/data/scraped/nightjet-trains.json").data.trains;
  let checked = 0;
  for (const row of Object.values(vm)) {
    if (row.timetable_source !== "nightjet") continue;
    if (![0, 1].some((d) => trains[row[`trip_short_name_${d}`]]?.operator === "EuroNight")) continue;
    const name = panelOperatorName(row, trains);
    assert.notEqual(name, "EuroNight", `${row.route_id} would read "EuroNight"`);
    assert.ok(name, `${row.route_id} has no operator name`);
    checked++;
  }
  assert.ok(checked >= 8, `${checked} partner rows`);
  const przemysl = vm.nj_standalone_EN_40417 ?? vm.nj_standalone_EN_40416;
  assert.equal(panelOperatorName(przemysl, trains), "PKP Intercity S.A.");
});

await check("committed payload: partner rows priced by no one, ÖBB's rows unchanged, no duplicate ES row, ČD's EN 442 back", () => {
  const vm = readJson("public/data/published/initial-data.json").data.viewMap;
  const trains = readJson("public/data/scraped/nightjet-trains.json").data.trains;
  const isPartner = (row) => [0, 1].some((d) => trains[row[`trip_short_name_${d}`]]?.operator === "EuroNight");
  let partnerRows = 0;
  let njPriced = 0;
  for (const row of Object.values(vm)) {
    if (row.timetable_source !== "nightjet") continue;
    const named = [0, 1].map((d) => trains[row[`trip_short_name_${d}`]]).filter(Boolean);
    if (isPartner(row)) {
      partnerRows++;
      for (const d of [0, 1]) {
        assert.equal(row[`fare_${d}`], undefined, `${row.route_id} fare_${d}`);
        assert.equal(row[`fare_calendar_${d}`], undefined, `${row.route_id} fare_calendar_${d}`);
      }
      assert.equal(row.pricing?.fromPrice ?? null, null, `${row.route_id} quotes no figure`);
      assert.ok(!String(row.agency_id).includes("/"), `${row.route_id} ${row.agency_id}`);
      const stated = named.find((t) => t.agencyFrom && t.agencyFrom !== "home");
      if (stated) {
        assert.equal(row.agency_id, stated.agency_id, `${row.route_id} takes the stated carrier`);
        assert.equal(row.bot_agency_id, row.agency_id, `${row.route_id} operating carrier`);
      }
      if (named.some((t) => t.fare === null)) {
        assert.equal(row.pricing?.type, null, `${row.route_id} gives no fare advice`);
        assert.ok(row.pricing, `${row.route_id} stops at its own empty record`);
      } else {
        assert.equal(row.agency_id, CONFIG.home, `${row.route_id}: only an unknown-carrier row keeps a fare model, ÖBB's`);
      }
    } else if (row.pricing?.fromPrice != null) {
      njPriced++;
      assert.equal(row.agency_id, "ÖBB");
    }
  }
  assert.ok(partnerRows >= 8, `${partnerRows} partner rows`);
  assert.ok(njPriced > 15, `${njPriced} ÖBB rows priced`);
  assert.ok(!Object.keys(vm).some((k) => k.startsWith("nj_standalone_ES")), "ES 452/453/475 appear once, as European Sleeper's");
  assert.equal(vm[237]?.agency_id, "ES");
  assert.equal(vm[238]?.agency_id, "ES");
  assert.equal(vm[6]?.agency_id, "ČD");
  const polylines = new Set(Object.values(trains).map((t) => t.polyline).filter(Boolean));
  assert.ok(!polylines.has(vm[6].nj_polyline ?? vm[6].nj_polyline_0), "row 6 draws no nightjet.com line");
  const przemysl = vm.nj_standalone_EN_40417 ?? vm.nj_standalone_EN_40416;
  assert.equal(przemysl.agency_id, "PKP", "München–Przemyśl is PKP's");
});

console.log(`\nverify-nj-operators: ${passed} checks passed`);
