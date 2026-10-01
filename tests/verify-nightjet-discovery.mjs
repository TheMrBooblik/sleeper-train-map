// tests/verify-nightjet-discovery.mjs
// The nightjet adapter must find every train the API lists, not only tonight's.
//
// It used to ask the API about one date, tonight, and the scrape runner trusts
// a healthy fetch completely — a train missing from it leaves the map that
// night. So a train that does not run tonight was simply not on the map, and
// ÖBB lists every diversion under its own number only on the dates it runs
// (NJ 498/499 for Hamburg–Wien over the summer works, NJ 11446, 13465…). Two
// more holes sat beside it: partner EuroNights found by the country search were
// thrown away in favour of the partner list, and that list was cut at 25.
//
// Runs the real adapter against a stubbed nightjet.com, so it pins the
// behaviour rather than the code. Raw node, no network.
// Run: npm run verify-nightjet-discovery
import assert from "node:assert";
import polyline from "@mapbox/polyline";
import {
  discoveryDates,
  discoverTrains,
  run,
} from "../scripts/adapters/nightjet.mjs";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const TONIGHT = "2026-10-01";
const stop = (name, lat, lon) => ({ station: { coords: [lat, lon], name: { de: name } } });
const route = (number, partner = false) => ({
  trainNumber: number,
  partnerTrain: partner,
  route: {
    polyline: polyline.encode([
      [48.2, 16.4],
      [48.0, 14.0],
      [47.8, 13.0],
    ]),
    stops: [stop("Wien Hbf", 48.2, 16.4), stop("Linz Hbf", 48.0, 14.0), stop("Salzburg Hbf", 47.8, 13.0)],
  },
});

// The scenario, by date. NJ 468 runs on Saturdays only; EN 414 is a partner
// train the country search lists and the partner list does not; the partner
// list carries 30 trains, more than the old cut of 25.
const SATURDAY = "2026-10-03";
const partnerList = Array.from({ length: 30 }, (_, i) => `EN ${1000 + i}`);
function fakeApi() {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    let m;
    if ((m = u.match(/country\/(\d+)\/country\/(\d+)\/(\d{4}-\d{2}-\d{2})$/))) {
      if (m[1] !== "81" || m[2] !== "80") return ok([]);
      const listed = [{ trainNumber: "NJ 490", partnerTrain: false }, { trainNumber: "EN 414", partnerTrain: true }];
      if (m[3] === SATURDAY) listed.push({ trainNumber: "NJ 468", partnerTrain: false });
      return ok(listed);
    }
    if ((m = u.match(/partner\/(\d{4}-\d{2}-\d{2})$/))) {
      return ok(partnerList.map((n) => ({ trainNumber: n, partnerTrain: true })));
    }
    if ((m = u.match(/train\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/))) {
      const n = decodeURIComponent(m[1]);
      // NJ 468 has no route on a night it does not run, like the real API.
      if (n === "NJ 468" && m[2] !== SATURDAY) return ok({ route: { stops: [] } });
      return ok(route(n, n.startsWith("EN")));
    }
    return { ok: false, status: 404, json: async () => null };
  };
  return calls;
}

async function scrape(params) {
  let written = null;
  const ctx = { today: TONIGHT, shared: {}, writtenTrains: {}, write: (_f, d) => (written = d) };
  await run({ output: "nightjet-trains.json", params }, ctx);
  return written.trains;
}

const PARAMS = { countryCodes: [80, 81], concurrency: 6, maxPartnerTrains: 100, discoveryDays: 7 };

await check("the discovery window is consecutive dates from tonight, across a month end", async () => {
  assert.deepStrictEqual(discoveryDates("2026-12-30", 4), [
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
  ]);
  assert.deepStrictEqual(discoveryDates(TONIGHT, 0), [TONIGHT], "at least tonight");
});

await check("a train that does not run tonight is found on the night it does", async () => {
  fakeApi();
  const trains = await scrape(PARAMS);
  assert.ok(trains["NJ 468"], "NJ 468 (Saturdays only) is kept");
  assert.ok(trains["NJ 490"]);
});

await check("tonight alone loses it — the fault, pinned", async () => {
  fakeApi();
  const trains = await scrape({ ...PARAMS, discoveryDays: 1 });
  assert.ok(!trains["NJ 468"], "a one-night window cannot see a Saturday train on a Thursday");
});

await check("a partner train the country search lists is kept", async () => {
  fakeApi();
  const trains = await scrape(PARAMS);
  assert.ok(trains["EN 414"], "EN 414 is not in the partner list, only in the country search");
  assert.strictEqual(trains["EN 414"].operator, "EuroNight");
});

await check("the partner list is not cut at 25", async () => {
  fakeApi();
  const trains = await scrape(PARAMS);
  for (const n of partnerList) assert.ok(trains[n], `${n} kept`);
});

await check("a cap that does cut says so, per date", async () => {
  fakeApi();
  const { partnerTruncated } = await discoverTrains({
    dates: [TONIGHT],
    countryCodes: [80, 81],
    maxPartnerTrains: 25,
  });
  assert.deepStrictEqual(partnerTruncated, [{ date: TONIGHT, listed: 30 }]);
});

await check("each train's route is fetched on the first date it is listed", async () => {
  const calls = fakeApi();
  await scrape(PARAMS);
  const routeCalls = calls.filter((u) => u.includes("/destinations/train/"));
  assert.ok(routeCalls.some((u) => u.endsWith(`NJ%20468/${SATURDAY}`)), "NJ 468 on Saturday");
  assert.ok(routeCalls.some((u) => u.endsWith(`NJ%20490/${TONIGHT}`)), "NJ 490 tonight");
  assert.strictEqual(
    routeCalls.filter((u) => u.includes("NJ%20490")).length,
    1,
    "one route request per train, not one per listed date",
  );
});

console.log(`\nverify-nightjet-discovery: ${passed} checks passed`);
