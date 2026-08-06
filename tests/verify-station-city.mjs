#!/usr/bin/env node
/**
 * Unit tests for scripts/lib/station-city.mjs — the city-level station matcher
 * that lets one operator's stop list be compared against another's.
 * Run: npm run verify-station-city
 *
 * Every case below is a real spelling pair seen in the feeds, not an invented
 * one: PLK transliterates umlauts ("Muenchen"), ČD appends terminal qualifiers
 * ("Praha-Michle autovlak"), Back-on-Track keeps local diacritics.
 */
import assert from "node:assert/strict";
import {
  sameCity,
  stationCity,
  stopsRunBetween,
  sliceToJourney,
} from "../scripts/lib/station-city.mjs";

// ── Same place, different spelling ──────────────────────────────────────────
for (const [a, b] of [
  ["Praha hl.n.", "Praha-Michle autovlak"],
  ["Praha hl.n.", "Praha Hlavni Nadrazi"],
  ["Budapest Keleti", "Budapest-Keleti pu"],
  ["München Hbf", "Muenchen Hbf"],
  ["München Hauptbahnhof", "Muenchen Hbf"],
  ["Przemyśl Gł.", "Przemysl Gl."],
  ["Frankfurt (Oder)", "Frankfurt(Oder)"],
  ["Warszawa Wschodnia", "Warszawa Centralna"],
]) {
  assert.ok(sameCity(a, b), `${a} should match ${b} (${stationCity(a)} / ${stationCity(b)})`);
}

// ── Different places that look similar ──────────────────────────────────────
for (const [a, b] of [
  ["Wien Hbf", "Wiener Neustadt"],
  ["Praha hl.n.", "Bratislava-N.Mesto"],
  ["Praha hl.n.", "Chorzow Batory"],
  ["Ostrava-Svinov", "Olomouc hl.n."],
]) {
  assert.ok(!sameCity(a, b), `${a} must not match ${b}`);
}
assert.ok(!sameCity("", "Praha"), "an empty name matches nothing");

// ── Endpoint validation ─────────────────────────────────────────────────────
// cd.cz answers a bare train number with whichever train it matched first, so
// a response has to be checked against the journey that asked for it.
const humenne = [
  { name: "Humenné" },
  { name: "Košice" },
  { name: "Praha hl.n." },
  { name: "Praha-Michle autovlak" },
];
assert.ok(stopsRunBetween(humenne, "Humenné", "Praha hl.n."));
assert.ok(stopsRunBetween(humenne, "Praha-Michle autovlak", "Humenné"), "either direction");
assert.ok(
  !stopsRunBetween([{ name: "Chorzow Batory" }, { name: "Lubliniec" }], "Przemyśl Gł.", "München Hbf"),
  "the wrong train cd.cz returned for EN 40417 is rejected",
);

// ── Trimming to the row's own journey ───────────────────────────────────────
// EN 442 runs on past Praha hl.n. to the car-carrier terminal. Reading the last
// stop's time would give a Humenné–Praha row an 08:38 arrival instead of 07:26.
const en442 = [
  { name: "Humenné", departure: "19:31" },
  { name: "Košice", arrival: "20:59", departure: "22:07" },
  { name: "Praha hl.n.", arrival: "07:26", departure: "07:39" },
  { name: "Praha-Michle autovlak", arrival: "08:38" },
];
const journey = sliceToJourney(en442, "Humenné", "Praha hl.n.");
assert.equal(journey.length, 3, "stops past the destination are dropped");
assert.equal(journey[journey.length - 1].arrival, "07:26", "arrival comes from the row's own station");
assert.equal(journey[0].departure, "19:31");

// The named station wins over a same-city one earlier in the list.
const viaSameCity = [
  { name: "Praha-Michle autovlak", departure: "21:15" },
  { name: "Praha hl.n.", departure: "22:16" },
  { name: "Humenné", arrival: "10:29" },
];
const j2 = sliceToJourney(viaSameCity, "Praha hl.n.", "Humenné");
assert.equal(j2.length, 2);
assert.equal(j2[0].departure, "22:16", "departs the station the row names, not its neighbour");

assert.equal(sliceToJourney(en442, "Warszawa", "Kraków"), null, "no journey → null");
assert.equal(sliceToJourney([{ name: "A" }], "A", "A"), null, "needs two stops");

console.log("verify-station-city: OK — city folding, endpoint validation, journey trimming");

// ── cd.cz deep links ────────────────────────────────────────────────────────
// A bare /vlak/{number} is ambiguous on cd.cz, so routes where it resolves to
// the wrong train pin the full path; `_DATE_` is filled with the journey date.
const { cdTrainPath } = await import("../scripts/adapters/cd.mjs");
const urls = { 10443: "10443/_DATE_/5457076/22.16/5100065/8.04/" };
assert.equal(
  cdTrainPath("10443", urls, new Date(2026, 7, 27)),
  "10443/27.8.2026/5457076/22.16/5100065/8.04/",
  "cd.cz wants D.M.YYYY, not a padded date",
);
assert.equal(cdTrainPath("442", urls), "442", "unpinned trains keep the bare number");
console.log("verify-station-city: cd.cz deep-link paths OK");
