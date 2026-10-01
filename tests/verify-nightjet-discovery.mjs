// tests/verify-nightjet-discovery.mjs
// The nightjet adapter must find every train nightjet.com lists — in any
// country, on any night — without being told which to look for.
//
// It used to ask about one date (tonight) and six hard-coded countries, and the
// scrape runner drops a train the moment a healthy fetch omits it. So a train
// not running tonight left the map, a train calling only outside DE/AT/IT/NL/
// CH/BE was never found, partner EuroNights the country search listed were
// thrown away for the partner list, and that list was cut at 25.
//
// Two live answers captured in a browser (tests/fixtures/nightjet/) pin the
// API's shape; the rest runs the real adapter against a stubbed nightjet.com
// that answers a country pair the way the live one does — every train calling
// in the first country and later in the second. Raw node, no network.
// Run: npm run verify-nightjet-discovery
import assert from "node:assert";
import fs from "node:fs";
import {
  discoverTrains,
  discoveryDates,
  fetchCountryPair,
  readListingEntry,
  run,
  stationCountry,
} from "../scripts/adapters/nightjet.mjs";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const fixture = (f) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/nightjet/${f}`, import.meta.url), "utf8"));

const TONIGHT = "2026-10-01"; // a Thursday
const SATURDAY = "2026-10-03";
const OCT15 = "2026-10-15";
const SEED = [80, 81, 83, 84, 85, 88];

// ─── A stubbed nightjet.com ─────────────────────────────────────────────────
// Each train: the UIC countries it calls in, in order; the nights it runs
// ("all" or a list); whether it is a partner train, and whether the partner
// list names it.
const NETWORK = {
  "NJ 490": { countries: ["81", "80"], days: "all" },
  "NJ 468": { countries: ["81", "80", "88"], days: [SATURDAY] },
  // A partner train the country search lists and the partner list does not.
  "EN 414": { countries: ["78", "79", "81", "80"], days: "all", partner: true },
  // Partner trains whose ends teach the search Poland and Hungary, and whose
  // routes teach it Czechia and Slovakia.
  "EN 40416": { countries: ["80", "81", "54", "51"], days: "all", partner: true, listed: true },
  "EN 40457": { countries: ["80", "54", "56", "55"], days: "all", partner: true, listed: true },
  "EN 40465": { countries: ["85", "81", "79", "78"], days: [OCT15], partner: true, listed: true },
  // Trains that touch none of the registry's six countries.
  "NJ 999": { countries: ["54", "51"], days: "all" },
  "R 555": { countries: ["56"], days: "all" }, // only Slovakia: learned from a route stop
};
// The live partner list is 16 long; this one is 33, past the old cut of 25.
for (let i = 0; i < 30; i++) {
  NETWORK[`EN ${1000 + i}`] = { countries: ["81", "81"], days: "all", partner: true, listed: true };
}

const runsOn = (t, date) => t.days === "all" || t.days.includes(date);
const nextRun = (t, date) =>
  t.days === "all" ? date : [...t.days].sort().find((d) => d >= date) ?? null;
const station = (country, i) => ({
  eva: `${country}0000${i}`,
  country,
  name: { de: `Station ${country}-${i}` },
  coords: [47 + i * 0.5, 9 + i],
});
const listingEntry = (n, t, date) => ({
  trainNumber: n,
  date,
  stationFrom: station(t.countries[0], 0),
  stationTo: station(t.countries.at(-1), t.countries.length - 1),
  partnerTrain: !!t.partner,
});

// lookAhead: whether the COUNTRY search answers with each train's next run
// (as the partner list demonstrably does) or only with tonight's trains.
function stubApi({ lookAhead }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    let m;
    if ((m = u.match(/country\/(\d+)\/country\/(\d+)\/(\d{4}-\d{2}-\d{2})$/))) {
      const [, from, to, date] = m;
      const out = [];
      for (const [n, t] of Object.entries(NETWORK)) {
        const i = t.countries.indexOf(from);
        if (i < 0 || !t.countries.slice(i).includes(to)) continue;
        const when = lookAhead ? nextRun(t, date) : runsOn(t, date) ? date : null;
        if (when) out.push(listingEntry(n, t, when));
      }
      return ok(out);
    }
    if ((m = u.match(/partner\/(\d{4}-\d{2}-\d{2})$/))) {
      return ok(
        Object.entries(NETWORK)
          .filter(([, t]) => t.listed && nextRun(t, m[1]))
          .map(([n, t]) => listingEntry(n, t, nextRun(t, m[1]))),
      );
    }
    if ((m = u.match(/train\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/))) {
      const n = decodeURIComponent(m[1]);
      const t = NETWORK[n];
      if (!t || !runsOn(t, m[2])) return ok({ route: { stops: [] } });
      return ok({
        trainNumber: n,
        partnerTrain: !!t.partner,
        route: { stops: t.countries.map((c, i) => ({ station: station(c, i) })) },
      });
    }
    return { ok: false, status: 404, json: async () => null };
  };
  return calls;
}

const PARAMS = { countryCodes: SEED, concurrency: 6, maxPartnerTrains: 100, discoveryDays: 7 };
async function scrape(params = PARAMS) {
  let written = null;
  const ctx = { today: TONIGHT, shared: {}, writtenTrains: {}, write: (_f, d) => (written = d) };
  await run({ output: "nightjet-trains.json", params }, ctx);
  return written.trains;
}
const quiet = async (fn) => {
  const log = console.log;
  const warn = console.warn;
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

// ─── The live answers ───────────────────────────────────────────────────────
console.log("live answers (tests/fixtures/nightjet)");

await check("a listing entry's date is the train's next run, not the date asked", () => {
  const partner = fixture("partner-2026-10-01.json").map((e) => readListingEntry(e, TONIGHT));
  assert.strictEqual(partner.length, 16);
  assert.strictEqual(partner.find((e) => e.trainNumber === "EN 40465").date, OCT15);
  assert.strictEqual(partner.find((e) => e.trainNumber === "EN 40414").date, "2026-10-14");
  assert.ok(partner.every((e) => e.partnerTrain));
});

await check("a listing names the countries of both ends — beyond the registry's six", () => {
  const countries = new Set(
    fixture("partner-2026-10-01.json").flatMap((e) => readListingEntry(e, TONIGHT).countries),
  );
  for (const c of ["51", "54", "55", "78"]) assert.ok(countries.has(c), `country ${c}`);
});

await check("a country pair outside the six answers, partner trains included", () => {
  const entries = fixture("country-54-81-2026-10-01.json").map((e) => readListingEntry(e, TONIGHT));
  assert.deepStrictEqual(entries.map((e) => e.trainNumber), ["EN 40417", "EN 40407", "NJ 457"]);
  assert.deepStrictEqual(entries.map((e) => e.partnerTrain), [true, true, false]);
});

await check("a route stop's country is the first two digits of its EVA number", () => {
  assert.strictEqual(stationCountry({ eva: "8011160" }), "80");
  assert.strictEqual(stationCountry({ id: "5100234" }), "51"); // a stored stop
  assert.strictEqual(stationCountry({ country: "55", eva: "8011160" }), "55", "own field wins");
  assert.strictEqual(stationCountry({ id: "NSR:Quay:1080" }), null);
});

// ─── Countries ──────────────────────────────────────────────────────────────
console.log("countries");

await check("the six seed countries alone cannot see a Czech–Polish train — the premise", async () => {
  stubApi({ lookAhead: false });
  for (const from of SEED)
    for (const to of SEED) {
      const { entries } = await fetchCountryPair(from, to, TONIGHT);
      assert.ok(!entries.some((e) => e.trainNumber === "NJ 999"), `${from}>${to}`);
    }
});

await check("a country the API mentions is searched, and its trains found", async () => {
  stubApi({ lookAhead: false });
  const trains = await quiet(() => scrape());
  assert.ok(trains["NJ 999"], "NJ 999 (CZ→PL only) is found");
});

await check("a country only a route's stops mention is searched too", async () => {
  stubApi({ lookAhead: false });
  const { trains, countries } = await quiet(() =>
    discoverTrains({ seedCodes: SEED, dates: [TONIGHT] }),
  );
  assert.ok(countries.includes("56"), "Slovakia, from EN 40457's stop list");
  assert.ok(trains.get("R 555")?.route, "R 555 (Slovakia only) is found, with its route");
});

// ─── Dates ──────────────────────────────────────────────────────────────────
console.log("dates");

await check("the discovery window is consecutive dates from tonight, across a month end", () => {
  assert.deepStrictEqual(discoveryDates("2026-12-30", 4), [
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
  ]);
  assert.deepStrictEqual(discoveryDates(TONIGHT, 0), [TONIGHT], "at least tonight");
});

await check("an API listing only tonight's trains: the window finds a Saturday train", async () => {
  stubApi({ lookAhead: false });
  const trains = await quiet(() => scrape());
  assert.ok(trains["NJ 468"]);
});

await check("…which tonight alone loses — the fault, pinned", async () => {
  stubApi({ lookAhead: false });
  const trains = await quiet(() => scrape({ ...PARAMS, discoveryDays: 1 }));
  assert.ok(!trains["NJ 468"]);
});

await check("an API listing each train's next run: one date is enough, and only one is asked", async () => {
  const calls = stubApi({ lookAhead: true });
  const trains = await quiet(() => scrape());
  assert.ok(trains["NJ 468"], "the Saturday train, from Thursday's answer");
  const asked = new Set(
    calls.filter((u) => u.includes("/destinations/country/")).map((u) => u.slice(-10)),
  );
  assert.deepStrictEqual([...asked], [TONIGHT]);
});

await check("each route is fetched on the night the train runs", async () => {
  const calls = stubApi({ lookAhead: true });
  const trains = await quiet(() => scrape());
  const routeCalls = calls.filter((u) => u.includes("/destinations/train/"));
  assert.ok(routeCalls.some((u) => u.endsWith(`NJ%20468/${SATURDAY}`)), "NJ 468 on Saturday");
  assert.ok(routeCalls.some((u) => u.endsWith(`EN%2040465/${OCT15}`)), "EN 40465 on 15 October");
  assert.ok(trains["EN 40465"], "and it is kept");
  assert.strictEqual(
    routeCalls.filter((u) => u.includes("NJ%20490")).length,
    1,
    "one route request per train",
  );
});

// ─── Partner trains ─────────────────────────────────────────────────────────
console.log("partner trains");

await check("a partner train the country search lists is kept", async () => {
  stubApi({ lookAhead: false });
  const trains = await quiet(() => scrape());
  assert.ok(trains["EN 414"], "EN 414 is not in the partner list, only in the country search");
  assert.strictEqual(trains["EN 414"].operator, "EuroNight");
});

await check("the partner list is not cut at 25", async () => {
  stubApi({ lookAhead: false });
  const trains = await quiet(() => scrape());
  for (let i = 0; i < 30; i++) assert.ok(trains[`EN ${1000 + i}`], `EN ${1000 + i}`);
});

await check("a cap that does cut says so, per date", async () => {
  stubApi({ lookAhead: false });
  const { partnerTruncated } = await quiet(() =>
    discoverTrains({ seedCodes: SEED, dates: [TONIGHT], maxPartnerTrains: 25, fetchRoutes: false }),
  );
  assert.deepStrictEqual(partnerTruncated, [{ date: TONIGHT, listed: 33 }]);
});

console.log(`\nverify-nightjet-discovery: ${passed} checks passed`);
