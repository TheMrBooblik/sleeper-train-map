#!/usr/bin/env node
/**
 * SNCF's open data beside its timetable: the Intercités de Nuit fare ranges
 * (tarifs-intercites) and punctuality (regularite-mensuelle-intercites).
 *
 * The fixtures below are SYNTHETIC — written from SNCF's documented column
 * labels, because ressources.data.sncf.com is unreachable from a dev sandbox.
 * Replace them with real records once `npm run probe-sncf-open-data` (the
 * "Probe SNCF open data" workflow, or the `run-probes` label) has fetched some.
 * The train ends are not synthetic: they are read off the committed
 * sncf-trains.json, so a train whose UIC code stopped coming through fails here.
 *
 * What is pinned, each against the fault it exists to prevent:
 *   - only berths are priced: a seat range on a pair day Intercités share is
 *     the day trains' as much as the night train's;
 *   - a restricted profile (Avantage, Jeune…) never sets the floor;
 *   - punctuality is never attributed on a pair a day train also runs;
 *   - a dataset that cannot be fetched costs its facts, never the trains, and
 *     last night's figures are carried;
 *   - the range reaches the row, the page and the FAQ, and stays out of the
 *     map's first payload.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyTariffClass,
  fareFromTariffs,
  isStandardAdultProfile,
  monthKey,
  namesMatch,
  odsExportUrls,
  pairKey,
  parseAmount,
  punctualityForTrain,
  readPunctualityRows,
  readTariffRows,
  recordsFromPayload,
  tariffColumns,
  trainEnds,
  uicKey,
} from "../scripts/lib/sncf-open-data.mjs";
import { carryPreviousPunctuality, runSncfOpenDataPass } from "../scripts/lib/sncf-open-data-pass.mjs";
import { dayServedStationPairs } from "../scripts/lib/gtfs.mjs";
import { stampOfficialFares, stampPunctuality } from "../src/pages/api/lib/build-initial-data.mjs";
import { stripPageOnlyFields } from "../src/pages/api/lib/payload-projection.mjs";
import { directionFareSummary, fareBasisLabel, fareClassRows, panelFareRows } from "../src/lib/fareClasses.mjs";
import { formatMonth, punctualityAnswer, punctualitySummary } from "../src/lib/punctuality.mjs";
import { buildConnectionFaq } from "../src/lib/seo/routeFaq.mjs";

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const TODAY = "2026-10-04";
const registry = JSON.parse(fs.readFileSync("data/sources/registry.json", "utf8"));
const sncfEntry = (registry.sources ?? registry).find((e) => e.id === "sncf");
const committed = JSON.parse(fs.readFileSync(`public/data/scraped/${sncfEntry.output}`, "utf8"));
const committedTrains = committed?.data?.trains ?? committed?.trains ?? {};

// A train as the GTFS adapter writes it: stations with the feed's stop ids.
const stop = (name, uic) => ({ name, code: `StopPoint:OCEINTERCITES de nuit-${uic}` });
const BRIANCON = { lineName: "IC Nuit 5789", stations: [stop("Paris Austerlitz", "87547000"), stop("Gap", "87763003"), stop("Briançon", "87763607")] };
const BRIANCON_BACK = { lineName: "IC Nuit 5790", stations: [stop("Briançon", "87763607"), stop("Paris Austerlitz", "87547000")] };
const TOULOUSE = { lineName: "IC Nuit 3751", stations: [stop("Paris Austerlitz", "87547000"), stop("Toulouse Matabiau", "87611004")] };
const LATOUR = { lineName: "IC Nuit 3971", stations: [stop("Paris Austerlitz", "87547000"), stop("Latour-de-Carol / La Tor de Querol", "87611483")] };

// SYNTHETIC tariff records in the v2.1 export's shape (field names as
// Opendatasoft derives them from SNCF's labels).
const tariffRecord = (o, ou, d, du, classe, profil, min, max) => ({
  transporteur: "Intercités",
  gare_origine: o, gare_origine_code_uic: ou,
  gare_destination: d, gare_destination_code_uic: du,
  classe, profil_tarifaire: profil, prix_minimum: min, prix_maximum: max,
});
const TARIFFS = [
  tariffRecord("PARIS AUSTERLITZ", "87547000", "BRIANCON", "87763607", "Couchette 2nde classe", "Tarif Normal", 39, 79),
  tariffRecord("PARIS AUSTERLITZ", "87547000", "BRIANCON", "87763607", "Couchette 1ère classe", "Tarif Normal", 59, 109),
  tariffRecord("PARIS AUSTERLITZ", "87547000", "BRIANCON", "87763607", "Couchette 2nde classe", "Tarif Avantage", 29, 59),
  tariffRecord("PARIS AUSTERLITZ", "87547000", "BRIANCON", "87763607", "Place assise 2nde", "Tarif Normal", 19, 49),
  // Paris–Toulouse: day Intercités too, so the bare class is ambiguous.
  tariffRecord("PARIS AUSTERLITZ", "87547000", "TOULOUSE MATABIAU", "87611004", "2", "Tarif Normal", 15, 89),
  tariffRecord("PARIS AUSTERLITZ", "87547000", "TOULOUSE MATABIAU", "87611004", "1", "Tarif Normal", 25, 119),
  // Latour-de-Carol listed only the other way round.
  tariffRecord("LATOUR DE CAROL ENVEITG", "87611483", "PARIS AUSTERLITZ", "87547000", "Couchette 2nde classe", "Plein tarif", "45,00", "85,00"),
];

// SYNTHETIC punctuality records, CSV as the classic download writes it.
const PUNCT_CSV = [
  "Date;Axe;Départ;Arrivée;Nombre de trains programmés;Nombre de trains ayant circulé;Nombre de trains annulés;Nombre de trains en retard à l'arrivée;Taux de régularité;Nombre de trains à l'heure pour un train en retard à l'arrivée",
  "2026-08;Paris - Briançon;PARIS AUSTERLITZ;BRIANCON;31;30;1;6;80;4",
  "2026-07;Paris - Briançon;PARIS AUSTERLITZ;BRIANCON;31;31;0;3;90,3;9",
  "2025-08;Paris - Briançon;PARIS AUSTERLITZ;BRIANCON;31;31;0;10;67,7;2",
  "2026-08;Paris - Briançon;BRIANCON;PARIS AUSTERLITZ;31;29;2;2;93,1;13",
  "2026-08;POLT;PARIS AUSTERLITZ;TOULOUSE MATABIAU;120;118;2;30;74,6;3",
  "2024-03;Paris - Latour;PARIS AUSTERLITZ;LATOUR DE CAROL;30;30;0;3;90;9",
].join("\n");

console.log("\nsncf open data\n");

await check("records read in every shape the portal answers with", () => {
  const flat = recordsFromPayload(TARIFFS);
  assert.equal(flat.length, TARIFFS.length);
  const nested = recordsFromPayload(TARIFFS.map((fields) => ({ datasetid: "x", recordid: "y", fields })));
  assert.deepEqual(nested, flat);
  assert.deepEqual(recordsFromPayload({ results: TARIFFS }), flat);
  assert.deepEqual(recordsFromPayload({ records: TARIFFS.map((fields) => ({ record: { fields } })) }), flat);
  assert.deepEqual(recordsFromPayload(JSON.stringify(TARIFFS)), flat);
  const csv = recordsFromPayload(PUNCT_CSV);
  assert.equal(csv.length, 6);
  assert.equal(csv[0]["Arrivée"], "BRIANCON");
  assert.equal(recordsFromPayload('"a";"b"\n"x;y";"z"')[0].a, "x;y", "a quoted separator stays in its cell");
  assert.deepEqual(recordsFromPayload("not json"), []);
  assert.deepEqual(recordsFromPayload(null), []);
  for (const url of odsExportUrls("tarifs-intercites")) assert.match(url, /^https:\/\/ressources\.data\.sncf\.com\/.*tarifs-intercites/);
});

await check("columns are found by what their labels say, in either spelling", () => {
  const ods = tariffColumns(TARIFFS);
  assert.deepEqual(
    [ods.originName, ods.originUic, ods.destName, ods.destUic, ods.classLabel, ods.profile, ods.min, ods.max],
    ["gare_origine", "gare_origine_code_uic", "gare_destination", "gare_destination_code_uic", "classe", "profil_tarifaire", "prix_minimum", "prix_maximum"],
  );
  const csvLabels = [{
    Transporteur: "Intercités", "Gare origine": "A", "Gare origine - code UIC": "87547000",
    "Gare destination": "B", "Gare destination - code UIC": "87763607",
    "Classe tarifaire": "Couchette", "Profil tarifaire": "Tarif Normal", "Prix minimum": "39", "Prix maximum": "79",
  }];
  const cols = tariffColumns(csvLabels);
  assert.equal(cols.classLabel, "Classe tarifaire");
  assert.equal(cols.profile, "Profil tarifaire", "a class column named \"tarifaire\" is not the profile");
  assert.equal(cols.originUic, "Gare origine - code UIC");
  const p = readPunctualityRows(recordsFromPayload(PUNCT_CSV));
  assert.equal(p.unread, 0);
  assert.equal(p.columns.late, "Nombre de trains en retard à l'arrivée", "not the on-time-per-late ratio");
  assert.equal(p.rows[0].late, 6);
});

await check("UIC codes and amounts read in every spelling SNCF writes", () => {
  assert.equal(uicKey("87547000"), "8754700");
  assert.equal(uicKey("0087547000"), "8754700");
  assert.equal(uicKey("8754700"), "8754700");
  assert.equal(uicKey("StopPoint:OCEINTERCITES de nuit-87547000"), "8754700");
  assert.equal(uicKey(87547000), "8754700");
  assert.equal(uicKey(""), null);
  assert.equal(uicKey("FRPAZ"), null);
  assert.equal(parseAmount("39,50 €"), 39.5);
  assert.equal(parseAmount(39), 39);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("n/a"), null);
  assert.equal(monthKey("2026-08"), "2026-08");
  assert.equal(monthKey("2026-08-01"), "2026-08");
  assert.equal(monthKey("08/2026"), "2026-08");
  assert.equal(monthKey("août 2026"), "2026-08");
  assert.equal(monthKey("?"), null);
});

await check("every committed SNCF train has a UIC code at both ends", () => {
  // The fare is matched on these; a feed that stopped carrying them would
  // fall back to names silently.
  const keys = Object.keys(committedTrains);
  assert.ok(keys.length >= 10, `only ${keys.length} committed SNCF trains`);
  for (const key of keys) {
    const ends = trainEnds(committedTrains[key]);
    assert.ok(ends?.origin.uic && ends?.destination.uic, `${key} lacks a UIC code at an end`);
  }
});

await check("a class is priced only when it says it sells a bed", () => {
  const cases = [
    ["Couchette 2nde classe", "couchetteSecond"],
    ["Couchette 1ère classe", "couchetteFirst"],
    ["Couchettes - 6 places", "couchetteSecond"],
    ["Compartiment 4 couchettes", "couchetteFirst"],
    ["Couchette", "couchette"],
    ["Place assise 2nde", "seat"],
    ["Siège inclinable", "seat"],
    // A bare class is a day train's as much as a night train's.
    ["2", null],
    ["1ère", null],
    ["Seconde", null],
    ["", null],
  ];
  for (const [label, want] of cases) assert.equal(classifyTariffClass(label), want, `classify(${JSON.stringify(label)})`);
  assert.equal(classifyTariffClass("2", "Tarif Liberté"), null, "\"lit\" inside a word is not a bed");
  assert.equal(classifyTariffClass("2nde", "Couchette"), "couchetteSecond", "the profile may carry the berth");
});

await check("restricted profiles never set the floor", () => {
  for (const p of ["Tarif Normal", "Plein tarif", "", "Tarif Loisir"]) assert.ok(isStandardAdultProfile(p), p);
  for (const p of ["Tarif Avantage", "Carte Jeune", "Tarif Senior", "Enfant", "Tarif réduit", "Abonnement", "Famille nombreuse"]) {
    assert.ok(!isStandardAdultProfile(p), p);
  }
});

await check("a train's fare is its couchettes' standard range, never a seat or a card fare", () => {
  const { rows } = readTariffRows(TARIFFS);
  const { fare } = fareFromTariffs(BRIANCON, rows, { today: TODAY, modified: "2025-12-26" });
  assert.deepEqual(fare, {
    fromPrice: 39,
    currency: "EUR",
    seatClass: "couchetteSecond",
    classes: { couchetteSecond: 39, couchetteFirst: 59 },
    classMax: { couchetteSecond: 79, couchetteFirst: 109 },
    basis: "tariff",
    sampledAt: TODAY,
    tariffModified: "2025-12-26",
  });
  // The reverse pair is the same tariff.
  const back = fareFromTariffs(BRIANCON_BACK, rows, { today: TODAY });
  assert.equal(back.fare.fromPrice, 39);
  assert.match(back.why, /reverse/);
  // Latour-de-Carol: listed only the other way, a bilingual name, comma decimals.
  assert.equal(fareFromTariffs(LATOUR, rows, { today: TODAY }).fare.classes.couchetteSecond, 45);
  // Paris–Toulouse: only bare classes, which day trains share — no fare.
  const tls = fareFromTariffs(TOULOUSE, rows, { today: TODAY });
  assert.equal(tls.fare, null);
  assert.match(tls.why, /classes that do not say: 2, 1/);
  assert.match(fareFromTariffs({ stations: [stop("Nowhere", "87000000"), stop("Else", "87000011")] }, rows).why, /no tariff row/);
});

await check("station names match on words, not substrings", () => {
  assert.ok(namesMatch("Latour-de-Carol / La Tor de Querol", "LATOUR DE CAROL"));
  assert.ok(namesMatch("Paris Austerlitz", "PARIS"));
  assert.ok(namesMatch("Briançon", "BRIANCON"));
  assert.ok(!namesMatch("Paris Austerlitz", "PARIS BERCY"));
  assert.ok(!namesMatch("Nice Ville", "NICE RIQUIER"));
  assert.ok(!namesMatch("Tarbes", "AEROPORT TARBES"));
});

await check("punctuality is the train's own direction, summed from counts", () => {
  const { rows } = readPunctualityRows(recordsFromPayload(PUNCT_CSV));
  const { value } = punctualityForTrain(BRIANCON, rows, { today: TODAY });
  assert.equal(value.month, "2026-08");
  assert.equal(value.onTimeRate, 80, "(30 − 6) / 30");
  assert.equal(value.cancelled, 1);
  // 2025-08 is 12 months back from 2026-08 and falls outside a 12-month window.
  assert.deepEqual(
    [value.trailing.months, value.trailing.from, value.trailing.ran, value.trailing.late],
    [2, "2026-07", 61, 9],
  );
  assert.equal(value.trailing.onTimeRate, 85.2, "summed counts, not averaged rates");
  const back = punctualityForTrain(BRIANCON_BACK, rows, { today: TODAY }).value;
  assert.equal(back.onTimeRate, 93.1, "Briançon → Paris is its own figure");
});

await check("punctuality is refused on a pair a day train runs, and when it is stale", () => {
  const { rows } = readPunctualityRows(recordsFromPayload(PUNCT_CSV));
  const dayServedPairs = new Set([pairKey("8754700", "8761100")]);
  const tls = punctualityForTrain(TOULOUSE, rows, { dayServedPairs, today: TODAY });
  assert.equal(tls.value, null);
  assert.match(tls.why, /daytime Intercités/);
  // The same rows without the gate would have printed the day trains' 74.6%.
  assert.ok(punctualityForTrain(TOULOUSE, rows, { today: TODAY }).value, "the gate is what refuses it");
  const old = punctualityForTrain(LATOUR, rows, { today: TODAY });
  assert.equal(old.value, null);
  assert.match(old.why, /too old/);
});

await check("the day-service gate reads the feed's own trips", () => {
  const gtfs = {
    stopTimesByTrip: new Map([
      // A day train Paris → Toulouse (08:27 → 15:05).
      ["day", [{ stop_id: "StopPoint:OCEINTERCITES-87547000", departure: "08:27:00", arrival: "08:27:00" }, { stop_id: "StopPoint:OCEINTERCITES-87611004", departure: "15:05:00", arrival: "15:05:00" }]],
      // The night train Paris → Briançon (20:57 → 08:24 the next day).
      ["night", [{ stop_id: "StopPoint:OCEINTERCITES de nuit-87547000", departure: "20:57:00", arrival: "20:57:00" }, { stop_id: "StopPoint:OCEINTERCITES de nuit-87763607", departure: "32:24:00", arrival: "32:24:00" }]],
      // A feed that resets at midnight says "next day" the other way.
      ["night2", [{ stop_id: "x-87547000", departure: "21:54:00", arrival: "21:54:00" }, { stop_id: "x-87611483", departure: "07:16:00", arrival: "07:16:00" }]],
    ]),
  };
  const pairs = dayServedStationPairs(gtfs, uicKey);
  assert.deepEqual([...pairs], [pairKey("8754700", "8761100")]);
});

const fakeFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => url.includes(k));
  if (!hit) return { ok: false, status: 404, text: async () => "" };
  const body = hit[1];
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
};

await check("the nightly pass writes both facts, and a failed night carries last night's", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sncf-open-data-"));
  const scraped = path.join(tmp, "public", "data", "scraped");
  fs.mkdirSync(scraped, { recursive: true });
  const entry = { ...sncfEntry, output: "sncf-trains.json" };
  const ctx = { today: TODAY, rootDir: tmp };
  // The feed carries a day Paris → Toulouse, so that pair gets no punctuality.
  const gtfs = {
    stopTimesByTrip: new Map([
      ["day", [{ stop_id: "x-87547000", departure: "08:27:00" }, { stop_id: "x-87611004", arrival: "15:05:00" }]],
    ]),
  };
  const logs = [];
  const log = (m) => logs.push(m);

  const trains = { "IC Nuit 5789": structuredClone(BRIANCON), "IC Nuit 3751": structuredClone(TOULOUSE) };
  const ok = fakeFetch({
    "datasets/tarifs-intercites/exports": TARIFFS,
    "datasets/regularite-mensuelle-intercites/exports": PUNCT_CSV,
    "catalog/datasets/tarifs-intercites": { metas: { default: { modified: "2025-12-26T09:00:00+00:00" } } },
  });
  const summary = await runSncfOpenDataPass(trains, { entry, ctx, gtfs, log, fetchImpl: ok });
  assert.equal(summary.priced, 1);
  assert.equal(trains["IC Nuit 5789"].fare.tariffModified, "2025-12-26");
  assert.equal(trains["IC Nuit 5789"].punctuality.onTimeRate, 80);
  assert.ok(!trains["IC Nuit 3751"].fare, "Paris–Toulouse states no berth class");
  assert.ok(!trains["IC Nuit 3751"].punctuality, "Paris–Toulouse is the day trains' figure");
  assert.ok(logs.some((l) => /IC Nuit 3751 not priced/.test(l)), "a miss says why in the log");

  // Tonight both hosts fail: the trains survive, last night's facts carry.
  fs.writeFileSync(path.join(scraped, "sncf-trains.json"), JSON.stringify({ data: { trains } }));
  const tonight = { "IC Nuit 5789": structuredClone(BRIANCON), "IC Nuit 3751": structuredClone(TOULOUSE) };
  const down = fakeFetch({ "data.sncf.com": new Error("connect ETIMEDOUT") });
  const failed = await runSncfOpenDataPass(tonight, { entry, ctx: { ...ctx, today: "2026-10-10" }, gtfs, log, fetchImpl: down });
  assert.equal(failed.priced, 0);
  assert.equal(failed.carriedFares, 1);
  assert.equal(failed.carriedPunctuality, 1);
  assert.equal(tonight["IC Nuit 5789"].fare.fromPrice, 39);
  assert.equal(tonight["IC Nuit 5789"].punctuality.sampledAt, TODAY, "a carried figure keeps its own date");
  // …but not forever.
  const stale = { "IC Nuit 5789": structuredClone(BRIANCON) };
  assert.equal(carryPreviousPunctuality(stale, trains, { today: "2026-12-31" }), 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

await check("the range and the punctuality reach the row, and stay off the map's first payload", () => {
  const { rows } = readTariffRows(TARIFFS);
  const fare = fareFromTariffs(BRIANCON, rows, { today: TODAY }).fare;
  const { value: punctuality } = punctualityForTrain(BRIANCON, readPunctualityRows(recordsFromPayload(PUNCT_CSV)).rows, { today: TODAY });
  const viewMap = {
    107: { route_id: 107, agency_id: "SNCF", timetable_source: "sncf", trip_short_name_0: "IC Nuit 5789", trip_short_name_1: "IC Nuit 5790" },
    // Another operator's row with a colliding label is never touched.
    999: { route_id: 999, agency_id: "ÖBB", timetable_source: "nightjet", trip_short_name_0: "IC Nuit 5789" },
  };
  const operatorTrains = { sncf: { "IC Nuit 5789": { fare, punctuality } } };
  stampOfficialFares(viewMap, {}, operatorTrains, [sncfEntry]);
  assert.deepEqual(viewMap[107].fare_0.classMax, { couchetteSecond: 79, couchetteFirst: 109 });
  assert.equal(viewMap[107].fare_0.basis, "tariff");
  assert.equal(viewMap[107].pricing.fromPrice, 39);
  assert.equal(viewMap[107].pricing.type, "dynamic", "SNCF's operator record");
  assert.equal(stampPunctuality(viewMap, operatorTrains, [sncfEntry]), 1);
  assert.equal(viewMap[107].punctuality_0.onTimeRate, 80);
  assert.ok(!viewMap[999].fare_0 && !viewMap[999].punctuality_0);
  const projected = stripPageOnlyFields({ viewMap });
  assert.ok(!("punctuality_0" in projected.viewMap[107]), "punctuality is a page fact");
  assert.ok("fare_0" in projected.viewMap[107], "the fare is not");
});

await check("pages print the published range and say whose it is", () => {
  const fare = {
    fromPrice: 39, currency: "EUR", seatClass: "couchetteSecond",
    classes: { couchetteSecond: 39, couchetteFirst: 59 }, classMax: { couchetteSecond: 79, couchetteFirst: 109 }, basis: "tariff",
  };
  assert.deepEqual(
    fareClassRows(fare, { from: true }).map((r) => [r.label, r.price]),
    [["Couchette, 2nd class", "€39–€79"], ["Couchette, 1st class", "€59–€109"]],
  );
  assert.deepEqual(panelFareRows(fare, { from: true }).map((r) => r.price), ["€39–€79", "€59–€109"]);
  // A fare without a range prints exactly as before.
  assert.deepEqual(fareClassRows({ currency: "EUR", classes: { couchette: 40 } }, { from: true }).map((r) => r.price), ["from €40"]);
  assert.match(fareBasisLabel(fare), /published by the operator/);
  assert.equal(fareBasisLabel({ classes: {} }), "");
  const summary = directionFareSummary({ fare_0: { ...fare, checkedAt: TODAY }, pricing: { type: "dynamic" } }, 0);
  assert.match(summary.basisLabel, /moves with demand/);
  const timetable = fs.readFileSync("src/components/seo/RouteTimetable.js", "utf8");
  assert.match(timetable, /fare\.basisLabel \|\| "Official fare"/);
  assert.match(timetable, /data-testid="route-punctuality"/);
});

await check("punctuality reads as a sentence, and the FAQ asks only when there is a figure", () => {
  const p = {
    month: "2026-08", onTimeRate: 80, ran: 30, late: 6, cancelled: 1,
    trailing: { months: 2, onTimeRate: 85.2, ran: 61, late: 9 }, lateAfterMinutes: 15, source: "regularite-mensuelle-intercites",
  };
  const s = punctualitySummary(p);
  assert.equal(s.headline, "80% on time");
  assert.equal(s.detail, "24 of 30 trains in August 2026 arrived within 15 minutes of schedule");
  assert.equal(s.trailing, "85% over the last 2 months (61 trains)");
  assert.equal(s.cancelled, "1 cancelled that month");
  assert.match(s.sourceUrl, /regularite-mensuelle-intercites/);
  assert.equal(punctualitySummary({ ...p, trailing: { ...p.trailing, months: 1 } }).trailing, "", "one month is the latest again");
  assert.equal(punctualitySummary(null), null);
  assert.equal(punctualitySummary({ ...p, ran: 0 }), null);
  assert.equal(formatMonth("2026-12"), "December 2026");
  const answer = punctualityAnswer([{ origin: "Paris Austerlitz", destination: "Briançon", punctuality: p }, { origin: "Briançon", destination: "Paris Austerlitz", punctuality: null }]);
  assert.equal(
    answer,
    "24 of 30 Paris Austerlitz → Briançon trains in August 2026 arrived within 15 minutes of schedule (80%; 85% over the last 2 months). These are the operator's own monthly figures, measured at the terminus.",
  );
  assert.equal(punctualityAnswer([]), "");
  const base = { originCity: "Briançon", destCity: "Paris", trainCount: 1, operators: ["SNCF"] };
  assert.ok(buildConnectionFaq({ ...base, punctualityText: answer }).some((f) => f.q === "Is the Briançon to Paris night train on time?" && f.a === answer));
  assert.ok(!buildConnectionFaq(base).some((f) => /on time/.test(f.q)));
});

await check("the SNCF entry asks for both datasets, and the probe can run from a PR", () => {
  assert.deepEqual(sncfEntry.params.openData, {
    base: "https://ressources.data.sncf.com",
    tariffs: "tarifs-intercites",
    punctuality: "regularite-mensuelle-intercites",
  });
  const wf = fs.readFileSync(".github/workflows/probe-sncf-open-data.yml", "utf8");
  assert.match(wf, /github\.event\.label\.name == 'run-probes'/);
  assert.match(wf, /set -o pipefail/);
  const adapter = fs.readFileSync("scripts/adapters/gtfs-sleeper.mjs", "utf8");
  assert.ok(
    adapter.indexOf("runSncfOpenDataPass(") < adapter.indexOf("ctx.write(entry.output"),
    "the pass must run before the trains file is written",
  );
});

console.log(`\n${checks} checks passed`);
