// tests/verify-icn-fares.mjs
// Trenitalia Intercity Notte fares from lefrecce.it: station-id mapping,
// response parsing (berth before seat), the adapter's search loop and the
// stamp onto the icn_ rows. No network. Run: npm run verify-icn-fares

import assert from "node:assert";
import {
  classifyService,
  lefrecceLocationId,
  parseAmount,
  parseSolutionsFare,
  romeClock,
  searchTimeBefore,
  solutionsRequestBody,
} from "../scripts/lib/lefrecce.mjs";
import { fetchIcnFare } from "../scripts/adapters/viaggiatreno.mjs";
import { stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";
import { fareClassRows, directionFare, fareClassLabel } from "../src/lib/fareClasses.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("lefrecceLocationId: 830 + the six digits of the Viaggiatreno code", () => {
  assert.strictEqual(lefrecceLocationId("S01700"), 830001700); // Milano Centrale
  assert.strictEqual(lefrecceLocationId("S08409"), 830008409); // Roma Termini
  assert.strictEqual(lefrecceLocationId("s12349"), 830012349); // Siracusa
  assert.strictEqual(lefrecceLocationId("NSR:Quay:1"), null);
  assert.strictEqual(lefrecceLocationId(null), null);
});

check("parseAmount: numbers, comma decimals, currency strings", () => {
  assert.strictEqual(parseAmount(39.9), 39.9);
  assert.strictEqual(parseAmount("39,90"), 39.9);
  assert.strictEqual(parseAmount("€ 119.00"), 119);
  assert.strictEqual(parseAmount(0), null);
  assert.strictEqual(parseAmount(null), null);
});

check("classifyService: seat / couchette / sleeper cabin, Italian and English", () => {
  assert.strictEqual(classifyService("Posto a sedere 2a classe"), "seat");
  assert.strictEqual(classifyService("Cuccetta Comfort 4 posti"), "couchette");
  assert.strictEqual(classifyService("Couchette 4 berths"), "couchette");
  assert.strictEqual(classifyService("Vagone Letto Singolo"), "sleeperCabin");
  assert.strictEqual(classifyService("Sleeper Excelsior"), "sleeperCabin");
  assert.strictEqual(classifyService("Bici"), null);
});

const RESPONSE = {
  solutions: [
    {
      // An earlier departure on the same pair: must not be priced as ours.
      solution: { trains: [{ name: "1955", acronym: "ICN" }], price: { amount: 19.9 } },
      grids: [{ services: [{ name: "Posto a sedere", offers: [{ price: { amount: 19.9 } }] }] }],
    },
    {
      solution: { trains: [{ name: "1963", acronym: "ICN" }], price: { currency: "€", amount: 29.9 } },
      grids: [
        {
          services: [
            { name: "Posto a sedere 2a classe", offers: [{ name: "Base", price: { amount: 49.9 } }, { name: "Economy", price: { amount: 29.9 } }] },
            { name: "Cuccetta Comfort 4 posti", offers: [{ name: "Base", price: { amount: 79.9 } }, { name: "Super Economy", price: { amount: 59.9 }, status: "SALEABLE" }] },
            // Sold out is not a fare anyone can buy.
            { name: "Vagone Letto Singolo", offers: [{ price: { amount: 49 }, status: "NOT_AVAILABLE" }, { price: { amount: 169 } }] },
          ],
        },
      ],
    },
  ],
};

check("parseSolutionsFare: our train only; from-price is the cheapest BERTH, not the seat", () => {
  const fare = parseSolutionsFare(RESPONSE, "1963");
  assert.deepStrictEqual(fare, {
    fromPrice: 59.9,
    currency: "EUR",
    seatClass: "couchette",
    classes: { seat: 29.9, couchette: 59.9, sleeperCabin: 169 },
  });
});

check("parseSolutionsFare: seats-only train → seat; no grid → headline price, no class; absent → null", () => {
  assert.deepStrictEqual(parseSolutionsFare(RESPONSE, "1955"), {
    fromPrice: 19.9,
    currency: "EUR",
    seatClass: "seat",
    classes: { seat: 19.9 },
  });
  const bare = { solutions: [{ solution: { trains: [{ name: "770" }], price: { amount: 44 } } }] };
  assert.deepStrictEqual(parseSolutionsFare(bare, "770"), { fromPrice: 44, currency: "EUR", seatClass: null, classes: {} });
  assert.strictEqual(parseSolutionsFare(RESPONSE, "999"), null);
  assert.strictEqual(parseSolutionsFare({}, "1963"), null);
});

check("romeClock / searchTimeBefore: Italian wall clock, a few minutes early", () => {
  assert.strictEqual(romeClock("2026-09-27T16:10:00.000Z"), "18:10"); // CEST
  assert.strictEqual(romeClock("2026-12-01T17:10:00.000Z"), "18:10"); // CET
  assert.strictEqual(searchTimeBefore("18:10"), "18:05");
  assert.strictEqual(searchTimeBefore("00:02"), "00:00");
});

check("solutionsRequestBody: direct trains only, from the given local time", () => {
  const b = solutionsRequestBody({ fromId: 830001700, toId: 830012349, date: "2026-10-18", time: "18:05" });
  assert.strictEqual(b.departureTime, "2026-10-18T18:05:00.000");
  assert.strictEqual(b.criteria.noChanges, true);
  assert.strictEqual(b.departureLocationId, 830001700);
});

const TRAIN = {
  lineName: "ICN 1963",
  stations: [
    { name: "Milano Centrale", code: "S01700", departure: "2026-09-27T16:10:00.000Z" },
    { name: "Siracusa", code: "S12349", arrival: "2026-09-28T10:00:00.000Z" },
  ],
};
const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

{
  // First sampled night the train does not run; the second it does.
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return jsonResponse(calls.length === 1 ? { solutions: [] } : RESPONSE);
  };
  const fare = await fetchIcnFare(TRAIN, { today: "2026-09-27", fetchImpl, log: () => {} });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].departureTime, "2026-10-18T18:05:00.000", "21 days out, 5 min before Milano's 18:10");
  assert.strictEqual(calls[1].departureTime, "2026-10-19T18:05:00.000");
  assert.strictEqual(calls[0].departureLocationId, 830001700);
  assert.strictEqual(calls[0].arrivalLocationId, 830012349);
  assert.strictEqual(fare.fromPrice, 59.9);
  assert.strictEqual(fare.sampledAt, "2026-09-27");
  assert.strictEqual(fare.travelDate, "2026-10-19");

  // A blocked/HTML answer costs the price, not the scrape, and is not retried.
  let n = 0;
  const blocked = await fetchIcnFare(TRAIN, {
    today: "2026-09-27",
    fetchImpl: async () => (n++, jsonResponse("<html>Access denied</html>", 403)),
    log: () => {},
  });
  assert.strictEqual(blocked, null);
  assert.strictEqual(n, 1);
  passed++;
  console.log("  ✓ fetchIcnFare: samples 3 weeks out, tries the next night, never throws");
}

check("stampOfficialFares: an official (not trusted) source prices its own rows", () => {
  const registry = [{ id: "italian", enabled: true, official: true, trusted: false }];
  const viewMap = {
    icn_ICN_1962: { route_id: "icn_ICN_1962", agency_id: "FS", timetable_source: "italian", trip_short_name_0: "ICN 1962", trip_short_name_1: "ICN 1963" },
  };
  const operatorTrains = {
    italian: {
      "ICN 1962": { fare: { fromPrice: 64.9, currency: "EUR", seatClass: "couchette", classes: { seat: 34.9, couchette: 64.9 }, sampledAt: "2026-09-27" } },
      "ICN 1963": { fare: { fromPrice: 59.9, currency: "EUR", seatClass: "couchette", classes: { seat: 29.9, couchette: 59.9, sleeperCabin: 169 }, sampledAt: "2026-09-27" } },
    },
  };
  assert.strictEqual(stampOfficialFares(viewMap, {}, operatorTrains, registry), 1);
  const row = viewMap.icn_ICN_1962;
  assert.strictEqual(row.pricing.fromPrice, 59.9);
  assert.strictEqual(row.pricing.currency, "EUR");
  assert.deepStrictEqual(
    fareClassRows(directionFare(row, 1)).map((r) => `${r.label} ${r.price}`),
    ["Seat €29.9", "Couchette €59.9", "Sleeper cabin €169"],
  );
  assert.strictEqual(fareClassLabel(row.pricing.seatClass), "Couchette");
});

console.log(`\n[verify-icn-fares] ${passed} checks passed`);
