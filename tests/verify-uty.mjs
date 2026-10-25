// tests/verify-uty.mjs
// Uzbekistan Railways (scripts/lib/uty.mjs, scripts/adapters/uty.mjs).
//
// tests/fixtures/uty/hub-sweep-2026-11-01.json is the eticket shop's real
// answer to POST /api/v3/handbook/trains/list for travel on 2026-11-01,
// Toshkent to and from fifteen stations, as the "Probe UTY source" workflow
// printed it on 2026-10-25 (run 40189621737), rebuilt into the answer's own
// shape. That run searched from the city code 2900000, so the config's hub is
// re-coded to it below; the nightly adapter searches from Toshkent Janubiy
// (2900002), which a later probe run showed lists the same night trains.
// week-2026-11-01.json is the same probe's seven dates of Toshkent → Xiva
// (numbers and departures only, as printed), for the days.
//
// Run: node tests/verify-uty.mjs

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "../scripts/lib/http-block.mjs";
import {
  BERTH_CAR_TYPES,
  buildUtyTrains,
  fareRecord,
  foldName,
  isNightSleeper,
  makeUtyClient,
  pairOrder,
  parseDateTime,
  readNight,
  readSearch,
  serviceDays,
  stationIndex,
  stationNamed,
  stopsFromObservations,
  sweepDates,
} from "../scripts/lib/uty.mjs";
import { run } from "../scripts/adapters/uty.mjs";
import { FARE_CLASS_LABELS, formatMoney } from "../src/lib/fareClasses.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "tests/fixtures/uty");
const realConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/uty-sleepers.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
const entry = registry.find((e) => e.id === "uty");
const sweep = JSON.parse(fs.readFileSync(path.join(FIX, "hub-sweep-2026-11-01.json"), "utf8"));
const week = JSON.parse(fs.readFileSync(path.join(FIX, "week-2026-11-01.json"), "utf8"));

// The fixture's hub is the city code.
const config = {
  ...realConfig,
  hub: "2900000",
  stations: realConfig.stations.map((s) => (s.code === realConfig.hub ? { ...s, code: "2900000" } : s)),
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("reading the shop's answers");
check("dates and clocks", eq(parseDateTime("01.11.2026 21:13"), { date: "2026-11-01", minutes: 1273, abs: Date.parse("2026-11-01T00:00:00Z") / 60000 + 1273 }) && parseDateTime("2026-11-01 21:13") === null);
check(
  "one station, many spellings",
  foldName("Toshkent  janubiy") === foldName("TOSHKENT JANUBIY") && foldName("ХИВА") === foldName("Xiva") && foldName("Qung'irot") === foldName("Qung‘irot"),
);
const index = stationIndex(realConfig);
check("ends resolve through the aliases, the shop's own typo included", stationNamed(index, "Toshkkent  janubiy")?.code === "2900002" && stationNamed(index, "Andijon 1")?.code === "2900680" && stationNamed(index, "Termez")?.code === "2900255" && stationNamed(index, "Qung'irot")?.code === "2900885");
const toTermiz = readSearch(sweep.answers["2900000>2900255"]);
const t080 = toTermiz.find((t) => t.number === "080Ф");
check("080Ф Toshkent → Termiz read", t080 && t080.dep.minutes === 21 * 60 + 13 && t080.arr.date === "2026-11-02", JSON.stringify(t080?.dep));
check(
  "berths priced per car type, seats and the common car left out",
  eq(t080?.classes, { utyPlatskart: 216700, utyKupe: 304210, utySv: 552040 }) && t080.berthCars === 3,
  JSON.stringify(t080?.classes),
);
const t129 = toTermiz.find((t) => t.number === "129Ф");
check("a train sold out has no car list", t129 && !t129.hasCars && !Object.keys(t129.classes).length);
const seats = readSearch(sweep.answers["2900000>2900800"]).find((t) => t.number === "712Ф");
check("a seats-only train sells no berth", seats && seats.hasCars && seats.berthCars === 0);
check("every fare class has a label", Object.values(BERTH_CAR_TYPES).every((k) => FARE_CLASS_LABELS[k]));
check("so'm grouped", formatMoney(216700, "UZS") === "UZS 216,700");

console.log("stop lists from the hub searches (real)");
const obsOf = (number) => {
  const out = [];
  for (const [pair, answer] of Object.entries(sweep.answers)) {
    const [from, to] = pair.split(">");
    for (const t of readSearch(answer)) if (t.number === number) out.push({ ...t, fromCode: from, toCode: to });
  }
  return out;
};
const built080 = stopsFromObservations(obsOf("080Ф"), { hub: "2900000", index: stationIndex(config) });
check(
  "080Ф: Toshkent, Guliston, Jizzax, Samarqand, Qarshi, Termiz",
  eq(built080.stops?.map((s) => s.name), ["Toshkent Janubiy", "Guliston", "Jizzax", "Samarqand", "Qarshi", "Termiz"]),
  JSON.stringify(built080),
);
check("…from 21:13", built080.originClock === 21 * 60 + 13);
const built126 = stopsFromObservations(obsOf("126Ф"), { hub: "2900000", index: stationIndex(config) });
const hub126 = built126.stops?.find((s) => s.code === "2900000");
check(
  "126Ф Xiva → Andijon runs through the hub: arrives 05:23, leaves 06:18",
  built126.stops?.[0].name === "Xiva" && built126.stops.at(-1).name === "Andijon" && hub126 && (built126.originClock + hub126.arrMinutes) % 1440 === 5 * 60 + 23 && (built126.originClock + hub126.depMinutes) % 1440 === 6 * 60 + 18,
  JSON.stringify(built126.stops?.map((s) => s.name)),
);
const verdict712 = isNightSleeper({ ...stopsFromObservations(obsOf("712Ф"), { hub: "2900000", index: stationIndex(config) }), berthCars: 0, anyCars: true }, config);
check("712Ф (seats, six hours) is not a sleeper", !verdict712.keep, JSON.stringify(verdict712));

console.log("a night (fake shop serving the real answers)");
const fakeClient = (answers) => ({
  requests: 0,
  blocked: null,
  async search(from, to, date) {
    this.requests++;
    const answer = date === sweep.date ? answers[`${from}>${to}`] : null;
    return answer ? readSearch(answer).map((t) => ({ ...t, fromCode: from, toCode: to, date })) : [];
  },
});
const night = await readNight({ client: fakeClient(sweep.answers), config, today: "2026-10-25", previous: {} });
check("first night: four consecutive sweep dates from a week out", eq(night.dates, ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]));
const kept = [...night.found.keys()].sort();
check(
  "the night trains with berths are kept",
  ["056Ж", "080Ф", "080Ь", "125Ч", "126Ф", "129Ф"].every((n) => kept.includes(n)) && !kept.includes("712Ф") && !kept.includes("734Ф"),
  JSON.stringify(kept),
);
check("a train running beyond the stations read is left out (124Ф to Volgograd)", !kept.includes("124Ф") && night.skipped.some((s) => s.startsWith("124Ф")));
check("080Ф's whole-journey fare comes from its own ends", eq(night.found.get("080Ф")?.fare?.classes, { utyPlatskart: 216700, utyKupe: 304210, utySv: 552040 }));

const flaky = fakeClient(sweep.answers);
const plain = flaky.search.bind(flaky);
flaky.search = async (from, to, date) => {
  if (date === "2026-11-05") throw new Error("HTTP 502");
  return plain(from, to, date);
};
const partial = await readNight({ client: flaky, config, today: "2026-10-25", previous: {} });
check("a date that fails leaves the days unknown, never shortened", partial.found.get("080Ф")?.frequency === null && partial.failures > 0);

// Kupe and SV sold out on the nearest date, on sale the day after: each class
// is priced from the nearest date that sells it (the real answer, with those
// two cars taken out of the first date's copy).
const termizAnswer = sweep.answers["2900000>2900255"];
const soldOut = JSON.parse(JSON.stringify(termizAnswer));
for (const t of soldOut.data.directions.forward.trains) t.cars = (t.cars ?? []).filter((c) => !["Kupe", "SV"].includes(c.type));
const twoDays = {
  requests: 0,
  blocked: null,
  async search(from, to, date) {
    const answer = from === "2900000" && to === "2900255" ? (date === "2026-11-01" ? soldOut : date === "2026-11-02" ? termizAnswer : null) : date === sweep.date ? sweep.answers[`${from}>${to}`] : null;
    return answer ? readSearch(answer).map((t) => ({ ...t, fromCode: from, toCode: to, date })) : [];
  },
};
const priced = (await readNight({ client: twoDays, config, today: "2026-10-25", previous: {} })).found.get("080Ф")?.fare;
check(
  "a class sold out on the nearest date is priced from the next date that sells it",
  eq(priced?.classes, { utyPlatskart: 216700, utyKupe: 304210, utySv: 552040 }) && priced.travelDate === "2026-11-01",
  JSON.stringify(priced),
);

console.log("days");
check("serviceDays", serviceDays(["2026-11-03", "2026-11-04", "2026-11-06", "2026-11-07"]) === "Tue, Wed, Fri, Sat" && serviceDays(Object.keys(week.dates)) === "Daily");
const xivaDays = Object.entries(week.dates).filter(([, trains]) => trains.some(([n]) => n === "056Ч")).map(([d]) => d);
check("056Ч Toshkent → Xiva runs Tue, Wed, Fri, Sat (probe, 2026-11-01 … 07)", serviceDays(xivaDays) === "Tue, Wed, Fri, Sat", serviceDays(xivaDays));

console.log("rotation and pairs");
check("after the first night: two consecutive dates, rotating", sweepDates({ today: "2026-10-25", hasPrevious: true }).length === 2 && !eq(sweepDates({ today: "2026-10-25", hasPrevious: true }), sweepDates({ today: "2026-10-26", hasPrevious: true })));
const order = pairOrder([
  { number: "126Ф", originCode: "X", terminusCode: "A" },
  { number: "080Ь", originCode: "T", terminusCode: "H" },
  { number: "125Ф", originCode: "A", terminusCode: "X" },
  { number: "080Ф", originCode: "H", terminusCode: "T" },
]).map((t) => t.number);
check("one number's two directions, then n and n + 1", eq(order, ["080Ф", "080Ь", "125Ф", "126Ф"]), JSON.stringify(order));

console.log("the trains file");
const trains = buildUtyTrains({ config, found: night.found, today: "2026-10-25", travelDate: "2026-11-01" });
const f080 = trains["080Ф"];
check("080Ф carries its stops with positions and times", f080 && f080.stations.length === 6 && f080.stations[0].departure === "21:13" && f080.stations.at(-1).arrival === "11:17" && f080.stations.at(-1).arrivalDay === 1 && f080.stations.every((s) => Number.isFinite(s.location.latitude)));
check("a stop carries only the time the shop stated", f080.stations[2].arrival === "23:48" && f080.stations[2].departure === null);
check("…14h04 long, operator UTY", f080.durationMinutes === 14 * 60 + 4 && f080.agency_id === "UTY", String(f080.durationMinutes));
check("so'm fare record", eq(fareRecord({ utyKupe: 3, utyPlatskart: 2 }, { sampledAt: "x", travelDate: "y" }), { fromPrice: 2, currency: "UZS", seatClass: "utyPlatskart", classes: { utyPlatskart: 2, utyKupe: 3 }, sampledAt: "x", travelDate: "y" }));
const carried = buildUtyTrains({ config, found: null, previous: trains, today: "2026-11-10" });
check("an unreachable shop carries last night's trains", Object.keys(carried).length === Object.keys(trains).length && carried["080Ф"].timetable.source === "previous");
check("…for at most 30 days", !Object.keys(buildUtyTrains({ config, found: null, previous: trains, today: "2026-12-01" })).length);

// The night 071Ф lost its stops (branch refresh, 2026-10-25): sweep dates
// that hold a run's first day but not the day after it reaches the hub. Here
// the fixture's 2026-11-01 is the second sweep date: 126Ф leaves Xiva on it
// and reaches Toshkent on the 2nd, outside the sweep.
let today2 = null;
for (let i = 0; i < 7 && !today2; i++) {
  const t = new Date(Date.parse("2026-10-20T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
  if (eq(sweepDates({ today: t, hasPrevious: true }), ["2026-10-31", "2026-11-01"])) today2 = t;
}
const second = await readNight({ client: fakeClient(sweep.answers), config, today: today2, previous: trains });
check(
  "a run caught only on the second sweep date keeps last night's stop list",
  !second.found.has("126Ф") && second.skipped.some((x) => x.startsWith("126Ф (only part")),
  JSON.stringify(second.skipped),
);
check("…while a run that reaches the hub the same day is read afresh (125Ч)", second.found.has("125Ч"));
const kept126 = buildUtyTrains({ config, found: second.found, previous: trains, today: today2 })["126Ф"];
check("…and the kept train has all its stops", kept126?.stations.length === trains["126Ф"].stations.length && kept126.timetable.source === "previous");

console.log("the client");
const calls = [];
const fakeFetch = (handler) => async (url, init) => {
  calls.push({ url, init });
  const r = handler(url, init, calls.length);
  return { status: r.status, text: async () => r.body ?? "", headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null, getSetCookie: () => r.cookies ?? [] } };
};
const client = makeUtyClient({
  fetchImpl: fakeFetch((url) => (url.endsWith("/csrf-token") ? { status: 200, cookies: ["XSRF-TOKEN=abc-123; Path=/"] } : { status: 200, body: JSON.stringify(sweep.answers["2900000>2900255"]) })),
  spacingMs: 0,
  detectBlock,
  userAgent: HONEST_USER_AGENT,
});
const res = await client.search("2900002", "2900255", "2026-11-01");
const post = calls.at(-1);
check("the token call first, then the search with the token echoed", calls[0].url.endsWith("/api/v1/csrf-token") && post.init.headers["X-XSRF-TOKEN"] === "abc-123" && post.init.headers.Cookie.includes("XSRF-TOKEN=abc-123"));
check("an honest User-Agent", post.init.headers["User-Agent"] === HONEST_USER_AGENT);
check("the station codes are the ones asked about", res.length === 2 && res.every((t) => t.fromCode === "2900002" && t.toCode === "2900255"));
calls.length = 0;
const blocked = makeUtyClient({ fetchImpl: fakeFetch((url) => (url.endsWith("/csrf-token") ? { status: 200 } : { status: 429, body: "Too many requests" })), spacingMs: 0, detectBlock, userAgent: HONEST_USER_AGENT });
let threw = null;
try {
  await blocked.search("2900002", "2900255", "2026-11-01");
} catch (err) {
  threw = err.message;
}
check("a 429 ('user_blocked') ends the night", /blocked/.test(threw ?? "") && blocked.blocked?.status === 429);
let budget = null;
const capped = makeUtyClient({ fetchImpl: fakeFetch(() => ({ status: 204 })), spacingMs: 0, maxRequests: 2, detectBlock, userAgent: HONEST_USER_AGENT });
try {
  await capped.search("a", "b", "2026-11-01");
  await capped.search("a", "b", "2026-11-01");
} catch (err) {
  budget = err.message;
}
check("a request budget", /budget/.test(budget ?? ""), budget);
calls.length = 0;
const lapsed = makeUtyClient({
  fetchImpl: fakeFetch((url, _i, n) => (url.endsWith("/csrf-token") ? { status: 200, cookies: [`XSRF-TOKEN=t${n}`] } : n === 2 ? { status: 403, body: "An expected CSRF token cannot be found" } : { status: 204 })),
  spacingMs: 0,
  detectBlock,
  userAgent: HONEST_USER_AGENT,
});
const after = await lapsed.search("a", "b", "2026-11-01");
check("a lapsed token is fetched again once, not read as a block", eq(after, []) && !lapsed.blocked && calls.filter((c) => c.url.endsWith("/csrf-token")).length === 2);

console.log("the adapter");
const written = {};
const adapterEntry = { ...entry, params: { ...entry.params, spacingMs: 0, osmTrack: null } };
const shop = (answers) =>
  fakeFetch((url, init) => {
    if (url.endsWith("/csrf-token")) return { status: 200, cookies: ["XSRF-TOKEN=x"] };
    const { date, depStationCode, arvStationCode } = JSON.parse(init.body).directions.forward;
    const from = depStationCode === "2900002" ? "2900000" : depStationCode;
    const to = arvStationCode === "2900002" ? "2900000" : arvStationCode;
    const a = date === sweep.date ? answers[`${from}>${to}`] : null;
    return a ? { status: 200, body: JSON.stringify(a) } : { status: 204 };
  });
const result = await run(adapterEntry, {
  rootDir: ROOT,
  today: "2026-10-25",
  fetch: shop(sweep.answers),
  write: (name, data) => (written[name] = data),
});
const file = written["uty-trains.json"];
check("the registry entry's adapter writes its trains file", file && Object.keys(file.trains).includes("080Ф"), JSON.stringify(Object.keys(file?.trains ?? {})));
check("…a week out", file?.travelDate === "2026-11-01");
// The fake shop answers only 2026-11-01 with trains and every other date
// empty, so the week reads one night: Sunday.
check("…days from the week between its own ends", file?.trains["080Ф"].frequency === "Sun", file?.trains["080Ф"].frequency);
check("…no warning on a clean night", result === undefined, JSON.stringify(result));

console.log("registry");
check("uty is enabled, official, untrusted", entry?.enabled && entry.official && !entry.trusted);
check("the endpoint is the address the adapter reads", entry?.endpoint === entry?.params.baseUrl);

console.log(failures ? `\nverify-uty: ${failures} failure(s)` : "\nverify-uty: all checks passed");
process.exit(failures ? 1 : 0);
