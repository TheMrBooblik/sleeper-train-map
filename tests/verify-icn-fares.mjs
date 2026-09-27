// tests/verify-icn-fares.mjs
// Trenitalia Intercity Notte fares from lefrecce.it: station-id mapping,
// response parsing (berth before seat), the adapter's search loop and the
// stamp onto the icn_ rows. No network. Run: npm run verify-icn-fares

import assert from "node:assert";
import {
  classifyService,
  describeSolutions,
  lefrecceLocationId,
  parseAmount,
  parseSolutionsFare,
  resolveLocationIdByName,
  searchTrainFare,
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
    classes: { couchette: 59.9, sleeperCabin: 169 },
    matchedBy: "number",
  });
});

check("parseSolutionsFare: seats never count — seats-only train or no grid → no fare", () => {
  assert.strictEqual(parseSolutionsFare(RESPONSE, "1955"), null, "a seats-only train gets no fare");
  const bare = { solutions: [{ solution: { trains: [{ name: "770" }], price: { amount: 44 } } }] };
  assert.strictEqual(parseSolutionsFare(bare, "770"), null, "the headline price is a seat, not a berth");
  assert.strictEqual(parseSolutionsFare(RESPONSE, "999"), null);
  assert.strictEqual(parseSolutionsFare({}, "1963"), null);
});

// The Palermo–Messina portions: sold under the main train's number, so ours
// (1954) is nowhere on the ticket — but the minute it leaves is.
const PORTION = {
  solutions: [
    { solution: { departureTime: "2026-10-18T14:05:00.000+02:00", trains: [{ acronym: "R", name: "5321" }], price: { amount: 12 } } },
    {
      solution: { departureTime: "2026-10-18T15:25:00.000+02:00", trains: [{ acronym: "ICN", name: "1956" }] },
      grids: [{ services: [{ name: "Cuccetta 4 posti", offers: [{ price: { amount: 39.9 } }] }] }],
    },
    // A regional leaving the same minute must not be taken for the sleeper.
    { solution: { departureTime: "2026-10-18T15:25:00.000+02:00", trains: [{ acronym: "R", name: "5323" }], price: { amount: 9 } } },
  ],
};

check("parseSolutionsFare: a portion sold under another number matches by departure minute + night category", () => {
  const fare = parseSolutionsFare(PORTION, "1954", { departureClock: "15:25" });
  assert.strictEqual(fare.fromPrice, 39.9);
  assert.strictEqual(fare.matchedBy, "departure");
  assert.strictEqual(parseSolutionsFare(PORTION, "1954", { departureClock: "16:00" }), null, "wrong minute → no match");
  assert.strictEqual(parseSolutionsFare(PORTION, "1954"), null, "no clock → number only");
  const twoNight = { solutions: [...PORTION.solutions, { solution: { departureTime: "2026-10-18T15:26:00", trains: [{ acronym: "ICN", name: "1958" }], price: { amount: 50 } } }] };
  assert.strictEqual(parseSolutionsFare(twoNight, "1954", { departureClock: "15:25" }), null, "two night trains in the window → price neither");
});

check("describeSolutions: what the search returned, for the log", () => {
  assert.deepStrictEqual(describeSolutions(PORTION), ["R 5321 14:05", "ICN 1956 15:25", "R 5323 15:25"]);
  assert.deepStrictEqual(describeSolutions({}), []);
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

{
  // A station id lefrecce refuses (Siracusa): 400, then a lookup by name, then a retry.
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("/locations/search")) {
      const name = decodeURIComponent(url.match(/name=([^&]+)/)[1]);
      const table = {
        Siracusa: [{ id: 830099999, name: "Siracusa", multistation: false }, { id: 1, name: "Siracusa (Tutte Le Stazioni)", multistation: true }],
        "Milano Centrale": [{ id: 830001700, name: "Milano Centrale" }],
      };
      return jsonResponse(table[name] ?? []);
    }
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.arrivalLocationId === 830012349) return jsonResponse({ error: "bad location" }, 400);
    return jsonResponse(RESPONSE);
  };
  const ids = new Map();
  const first = await searchTrainFare(
    { fromCode: "S01700", toCode: "S12349", fromName: "Milano Centrale", toName: "Siracusa", date: "2026-10-18", time: "18:05", trainNumber: "1963" },
    { fetchImpl, ids },
  );
  assert.strictEqual(first.fare.fromPrice, 59.9);
  assert.deepStrictEqual(bodies.map((b) => b.arrivalLocationId), [830012349, 830099999]);
  assert.strictEqual(ids.get("S12349"), 830099999, "resolved id is cached for the night");
  bodies.length = 0;
  await searchTrainFare(
    { fromCode: "S01700", toCode: "S12349", fromName: "Milano Centrale", toName: "Siracusa", date: "2026-10-19", time: "18:05", trainNumber: "1963" },
    { fetchImpl, ids },
  );
  assert.deepStrictEqual(bodies.map((b) => b.arrivalLocationId), [830099999], "no second 400 once cached");
  assert.strictEqual(await resolveLocationIdByName("Nowhere", { fetchImpl }), null);
  passed++;
  console.log("  ✓ searchTrainFare: a refused station id is resolved by name, retried, and cached");
}

check("stampOfficialFares: an official (not trusted) source prices its own rows", () => {
  const registry = [{ id: "italian", enabled: true, official: true, trusted: false }];
  const viewMap = {
    icn_ICN_1962: { route_id: "icn_ICN_1962", agency_id: "FS", timetable_source: "italian", trip_short_name_0: "ICN 1962", trip_short_name_1: "ICN 1963" },
  };
  const operatorTrains = {
    italian: {
      "ICN 1962": { fare: { fromPrice: 64.9, currency: "EUR", seatClass: "couchette", classes: { couchette: 64.9 }, sampledAt: "2026-09-27" } },
      // An older file may still carry a seat: it must not be listed.
      "ICN 1963": { fare: { fromPrice: 59.9, currency: "EUR", seatClass: "couchette", classes: { seat: 29.9, couchette: 59.9, sleeperCabin: 169 }, sampledAt: "2026-09-27" } },
    },
  };
  assert.strictEqual(stampOfficialFares(viewMap, {}, operatorTrains, registry), 1);
  const row = viewMap.icn_ICN_1962;
  assert.strictEqual(row.pricing.fromPrice, 59.9);
  assert.strictEqual(row.pricing.currency, "EUR");
  assert.deepStrictEqual(
    fareClassRows(directionFare(row, 1)).map((r) => `${r.label} ${r.price}`),
    ["Couchette €59.9", "Sleeper cabin €169"],
  );
  assert.strictEqual(fareClassLabel(row.pricing.seatClass), "Couchette");
  assert.strictEqual(row.pricing.type, "dynamic", "FS has a fare model, so the Price badge renders");
});

console.log(`\n[verify-icn-fares] ${passed} checks passed`);
