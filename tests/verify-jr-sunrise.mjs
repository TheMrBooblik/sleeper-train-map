// tests/verify-jr-sunrise.mjs
// The Sunrise Izumo / Sunrise Seto source (scripts/lib/jr-sunrise.mjs,
// scripts/adapters/jr-sunrise.mjs) and the booking guide it ships with.
//
// The page fixtures below are SYNTHETIC. JR's hosts are unreachable from the
// machine this was written on, so they are built in the shapes a Japanese
// railway timetable takes — a 駅 / 着 / 発 table with empty cells and レ for a
// passed station, "東京 21:26発" lines, an English "Dep. 21:26" list — and
// the checks pin behaviour that must hold whichever of those JR serves: a
// station matches only as a whole segment (富士 is not 富士川), a train is taken
// whole or not at all, and a page for another train cannot validate. What the
// live pages actually look like is printed by the "Probe JR Sunrise source"
// workflow; when it shows a real page, commit it under tests/fixtures/ and
// replace these.
//
// Run: npm run verify-jr-sunrise

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  MAX_DRIFT_MINUTES,
  acceptRoomCharges,
  buildSunriseTrains,
  discoverTimetableIds,
  extractStopRecords,
  fareForTrain,
  htmlSegments,
  makeStationMatcher,
  normalizeStationName,
  parseRoomCharges,
  timetableFromPage,
  timesInText,
  trainPath,
  validateConfig,
} from "../scripts/lib/jr-sunrise.mjs";
import { decodeBody, run } from "../scripts/adapters/jr-sunrise.mjs";
import { validateRegistry } from "../scripts/lib/registry.mjs";
import {
  BOOKING_GUIDES,
  bookingGuideFor,
  getBookingGuide,
  guideProps,
  withBookingGuideFaq,
} from "../src/lib/bookingGuide.mjs";
import { FARE_CLASS_LABELS, fareClassRows, formatMoney } from "../src/lib/fareClasses.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const config = readJson("data/sources/jr-sunrise.json");
const registry = readJson("data/sources/registry.json");
const entry = registry.find((e) => e.id === "jr-sunrise");
const train = (name) => config.trains.find((t) => t.lineName === name);
const matchStation = makeStationMatcher(config.stations);

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks++;
  console.log(`  ✓ ${name}`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

// The westbound Sunrise Izumo as a 駅名 / 着 / 発 table: empty cells, passed
// stations marked レ, and 富士川 (a station this train passes) right after 富士.
const IZUMO_WEST_TABLE = `
<html><head><meta charset="utf-8"><title>寝台特急 サンライズ出雲 出雲市行</title></head><body>
<h1>寝台特急 サンライズ出雲 出雲市行</h1>
<table>
<tr><th>駅名</th><th>着</th><th>発</th></tr>
<tr><td>東京</td><td></td><td>21:26</td></tr>
<tr><td>品川</td><td>レ</td><td>レ</td></tr>
<tr><td>横浜</td><td>21:50</td><td>21:52</td></tr>
<tr><td>熱海</td><td>22:55</td><td>22:57</td></tr>
<tr><td>沼津</td><td></td><td>23:16</td></tr>
<tr><td>富士</td><td></td><td>23:32</td></tr>
<tr><td>富士川</td><td>レ</td><td>レ</td></tr>
<tr><td>静岡</td><td></td><td>23:59</td></tr>
<tr><td>浜松</td><td></td><td>0:54</td></tr>
<tr><td>名古屋</td><td>レ</td><td>レ</td></tr>
<tr><td>大阪</td><td>レ</td><td>レ</td></tr>
<tr><td>姫路</td><td>5:25</td><td>5:26</td></tr>
<tr><td>岡山</td><td>6:27</td><td>6:31</td></tr>
<tr><td>倉敷</td><td></td><td>6:46</td></tr>
<tr><td>備中高梁</td><td></td><td>7:15</td></tr>
<tr><td>新見</td><td></td><td>7:44</td></tr>
<tr><td>根雨</td><td>レ</td><td>レ</td></tr>
<tr><td>米子</td><td></td><td>9:05</td></tr>
<tr><td>安来</td><td></td><td>9:14</td></tr>
<tr><td>松江</td><td></td><td>9:33</td></tr>
<tr><td>宍道</td><td></td><td>9:47</td></tr>
<tr><td>出雲市</td><td>10:00</td><td></td></tr>
</table>
<p>ご注意 運転日</p><p>更新 2026/09/28 10:15</p>
</body></html>`;

// The eastbound Sunrise Seto as a list of "駅 時刻発" lines, full-width digits
// and the 時/分 spelling included, on a night it starts at Kotohira.
const SETO_EAST_LINES = `
<ul>
<li>琴平 20:25発</li>
<li>高松 21:17着 21:26発</li>
<li>坂出 ２１:４３発</li>
<li>児島 22時03分発</li>
<li>岡山 22:23着 22:34発</li>
<li>姫路 23:34発</li>
<li>三ノ宮 0:10発</li>
<li>大阪 0:31着 0:33発</li>
<li>静岡 4:40発</li>
<li>富士 5:08発</li>
<li>沼津 5:25発</li>
<li>熱海 5:43発</li>
<li>横浜 6:44着</li>
<li>東京 7:08着</li>
</ul>`;

// The westbound Sunrise Seto in English, "Dep." / "Arr." beside the time.
const SETO_WEST_ENGLISH = `
<dl>
<dt>Tokyo</dt><dd>Dep. 21:26</dd>
<dt>Yokohama</dt><dd>Dep. 21:52</dd>
<dt>Atami</dt><dd>Dep. 22:57</dd>
<dt>Numazu</dt><dd>Dep. 23:16</dd>
<dt>Fuji</dt><dd>Dep. 23:32</dd>
<dt>Shizuoka</dt><dd>Dep. 23:59</dd>
<dt>Hamamatsu</dt><dd>Dep. 00:54</dd>
<dt>Himeji</dt><dd>Dep. 05:26</dd>
<dt>Okayama</dt><dd>Arr. 06:27</dd><dd>Dep. 06:34</dd>
<dt>Kojima</dt><dd>Dep. 06:51</dd>
<dt>Sakaide</dt><dd>Dep. 07:12</dd>
<dt>Takamatsu</dt><dd>Arr. 07:27</dd>
</dl>`;

const ROOMS_PAGE = `
<table>
<tr><th>設備</th><th>寝台料金</th></tr>
<tr><td>シングルデラックス</td><td>13,980円</td></tr>
<tr><td>サンライズツイン<br>(1室2名)</td><td>15,400円</td></tr>
<tr><td>シングルツイン</td><td>9,600円</td><td>(2名利用時 追加 5,500円)</td></tr>
<tr><td>シングル</td><td>7,700円</td></tr>
<tr><td>ソロ</td><td>6,600円</td></tr>
<tr><td>ノビノビ座席</td><td>寝台料金不要</td></tr>
</table>
<a href="https://timetable.jr-odekake.net/train-timetable/3841?date=20261001">下り</a>
<a href="/train-timetable/9999">臨時</a>`;

// ─── 1. The committed baseline ───────────────────────────────────────────────

await check("the config is structurally sound and the registry accepts the entry", () => {
  assert.deepEqual(validateConfig(config), []);
  assert.ok(entry, "registry has a jr-sunrise entry");
  assert.deepEqual(validateRegistry(registry), []);
  assert.equal(entry.official, true);
  assert.equal(entry.params.configPath, "data/sources/jr-sunrise.json");
  assert.ok(entry.params.timetableUrlTemplate.includes("{id}") && entry.params.timetableUrlTemplate.includes("{date}"));
});

await check("stop patterns differ by direction, as the operator runs them", () => {
  const stopsOf = (name) => train(name).stops.map((s) => s.station);
  for (const west of ["Sunrise Izumo 4031M", "Sunrise Seto 5031M"]) {
    assert.ok(stopsOf(west).includes("hamamatsu"), `${west} serves Hamamatsu`);
    assert.ok(!stopsOf(west).includes("osaka"), `${west} passes Osaka without stopping`);
    assert.ok(!stopsOf(west).includes("sannomiya"), `${west} passes Sannomiya without stopping`);
  }
  for (const east of ["Sunrise Izumo 4032M", "Sunrise Seto 5032M"]) {
    assert.ok(stopsOf(east).includes("osaka") && stopsOf(east).includes("sannomiya"), `${east} serves Osaka and Sannomiya`);
    assert.ok(!stopsOf(east).includes("hamamatsu"), `${east} does not stop at Hamamatsu`);
  }
  // Each train's endpoints carry the times the planner and the pages print.
  for (const t of config.trains) {
    assert.ok(t.stops[0].departure, `${t.lineName} has a departure`);
    assert.ok(t.stops.at(-1).arrival, `${t.lineName} has an arrival`);
  }
});

await check("every train is drawn along its corridor, through each of its stops", () => {
  for (const t of config.trains) {
    const pts = trainPath(config, t);
    const byId = new Map(config.stations.map((s) => [s.id, s]));
    let cursor = 0;
    for (const stop of t.stops) {
      const s = byId.get(stop.station);
      const at = pts.findIndex((p, i) => i >= cursor && p[0] === s.lat && p[1] === s.lon);
      assert.ok(at >= 0, `${t.lineName}: ${stop.station} is a vertex of the line, in order`);
      cursor = at + 1;
    }
    // No stroke longer than ~140 km: the westbound train passes Nagoya, Kyoto
    // and Osaka without a passenger stop, and the line must still follow them.
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const km = Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * Math.cos((a[0] * Math.PI) / 180));
      assert.ok(km < 140, `${t.lineName}: a ${km.toFixed(0)} km jump in the drawn line`);
    }
  }
});

await check("a stop that is not on its corridor is refused, not drawn", () => {
  const broken = structuredClone(config);
  broken.trains[0].stops.splice(2, 0, { station: "kojima", departure: null });
  assert.ok(validateConfig(broken).some((p) => /kojima/.test(p)));
});

// ─── 2. Reading a timetable page ─────────────────────────────────────────────

await check("names fold the way JR writes them", () => {
  assert.equal(normalizeStationName("Izumo-Shi"), normalizeStationName("Izumoshi"));
  assert.equal(normalizeStationName("岡山駅"), normalizeStationName("岡山"));
  assert.equal(normalizeStationName("三ノ宮(JR)"), normalizeStationName("三ノ宮"));
  assert.equal(matchStation("Bicchu-Takahashi"), "bitchu-takahashi");
  assert.equal(matchStation("富士"), "fuji");
  assert.equal(matchStation("富士川"), null, "a station name inside another is not that station");
});

await check("times are read in every spelling a Japanese timetable uses", () => {
  assert.deepEqual(timesInText("21:26発"), [{ time: "21:26", label: "dep" }]);
  assert.deepEqual(timesInText("着 6:27"), [{ time: "06:27", label: "arr" }]);
  assert.deepEqual(timesInText("22時03分発"), [{ time: "22:03", label: "dep" }]);
  assert.deepEqual(timesInText("Arr. 06:27"), [{ time: "06:27", label: "arr" }]);
  assert.deepEqual(htmlSegments("<td>２１:４３</td>"), ["21:43"], "full-width digits fold");
  assert.deepEqual(timesInText("2026/09/28"), [], "a date is not a time");
});

await check("a 駅/着/発 table yields the westbound Izumo, whole", () => {
  const result = timetableFromPage(IZUMO_WEST_TABLE, train("Sunrise Izumo 4031M"), matchStation);
  assert.ok(result.stops, `validates: ${result.problems}`);
  const at = Object.fromEntries(result.stops.map((s) => [s.station, s]));
  assert.equal(at.tokyo.departure, "21:26");
  assert.equal(at.tokyo.arrival, null, "an origin has no arrival");
  assert.deepEqual([at.yokohama.arrival, at.yokohama.departure], ["21:50", "21:52"]);
  assert.equal(at.fuji.departure, "23:32", "富士川's レ did not become Fuji's");
  assert.equal(at.hamamatsu.departure, "00:54");
  assert.deepEqual([at.okayama.arrival, at.okayama.departure], ["06:27", "06:31"]);
  assert.equal(at["bitchu-takahashi"].departure, "07:15");
  assert.equal(at.izumoshi.arrival, "10:00");
  assert.equal(at.izumoshi.departure, null);
});

await check("a page for one train does not validate for another", () => {
  // The Izumo page lacks every Seto branch stop; the eastbound trains run the
  // other way round. Neither may borrow it.
  for (const name of ["Sunrise Seto 5031M", "Sunrise Izumo 4032M", "Sunrise Seto 5032M"]) {
    const result = timetableFromPage(IZUMO_WEST_TABLE, train(name), matchStation);
    assert.ok(!result.stops, `${name} must not validate against the westbound Izumo page`);
  }
});

await check("a line-per-stop page yields the eastbound Seto, even starting at Kotohira", () => {
  const result = timetableFromPage(SETO_EAST_LINES, train("Sunrise Seto 5032M"), matchStation);
  assert.ok(result.stops, `validates: ${result.problems}`);
  const at = Object.fromEntries(result.stops.map((s) => [s.station, s]));
  // Kotohira is not a stop we know, so its 20:25 closes nothing onto Takamatsu:
  // the train still starts where the row says, at 21:26.
  assert.equal(at.takamatsu.departure, "21:26");
  assert.equal(at.takamatsu.arrival, null);
  assert.equal(at.sakaide.departure, "21:43");
  assert.equal(at.kojima.departure, "22:03");
  assert.deepEqual([at.osaka.arrival, at.osaka.departure], ["00:31", "00:33"]);
  assert.equal(at.tokyo.arrival, "07:08");
});

await check("an English Dep./Arr. page yields the westbound Seto", () => {
  const result = timetableFromPage(SETO_WEST_ENGLISH, train("Sunrise Seto 5031M"), matchStation);
  assert.ok(result.stops, `validates: ${result.problems}`);
  const at = Object.fromEntries(result.stops.map((s) => [s.station, s]));
  assert.deepEqual([at.okayama.arrival, at.okayama.departure], ["06:27", "06:34"]);
  assert.equal(at.takamatsu.arrival, "07:27");
});

await check("a stop shown as passed, a missing stop or a moved train is refused", () => {
  const izumo = train("Sunrise Izumo 4031M");
  const passed = IZUMO_WEST_TABLE.replace("<td>米子</td><td></td><td>9:05</td>", "<td>米子</td><td>レ</td><td>レ</td>");
  assert.match(timetableFromPage(passed, izumo, matchStation).problems.join(), /yonago is shown as passed/);

  const missing = IZUMO_WEST_TABLE.replace(/<tr><td>安来<\/td>.*?<\/tr>/, "");
  assert.match(timetableFromPage(missing, izumo, matchStation).problems.join(), /yasugi not found/);

  // Two hours later than the baseline: another train's page, not a retiming.
  const later = IZUMO_WEST_TABLE.replace("<td>21:26</td>", "<td>23:40</td>");
  const drift = timetableFromPage(later, izumo, matchStation).problems.join();
  assert.match(drift, new RegExp(`tokyo departure 23:40 is \\d+ min from the baseline`));
  assert.ok(MAX_DRIFT_MINUTES >= 30, "a real retiming (24 min in March 2026) must still pass");
});

await check("timetable ids are discovered from a guide page's links", () => {
  assert.deepEqual(discoverTimetableIds(ROOMS_PAGE).sort((a, b) => a - b), [3841, 9999]);
  assert.deepEqual(discoverTimetableIds(null), []);
});

await check("a Shift_JIS page decodes, so its station names still match", () => {
  // 東京 in Shift_JIS, declared by a <meta> — decoded as UTF-8 it matches nothing.
  const head = Buffer.from('<meta charset="Shift_JIS"><td>', "latin1");
  const tokyo = Buffer.from([0x93, 0x8c, 0x8b, 0x9e]);
  const html = decodeBody(Buffer.concat([head, tokyo, Buffer.from("</td>")]));
  assert.ok(html.includes("東京"), html);
  assert.equal(decodeBody(Buffer.from("<td>東京</td>"), "text/html; charset=UTF-8"), "<td>東京</td>");
});

// ─── 3. Berth charges and fares ──────────────────────────────────────────────

await check("berth charges are read per room, Single never taken for Single Twin", () => {
  assert.deepEqual(parseRoomCharges(ROOMS_PAGE), {
    singleDeluxe: 13980,
    sunriseTwin: 15400,
    singleTwin: 9600,
    single: 7700,
    solo: 6600,
  });
});

await check("a misread charge or an impossible order falls back to the baseline", () => {
  const base = config.fares.roomCharges;
  const misread = acceptRoomCharges({ single: 770, solo: 6800 }, base);
  assert.equal(misread.charges.single, base.single, "770 is a misread, not a fare");
  assert.equal(misread.charges.solo, 6800, "a plausible change is taken");
  assert.deepEqual(misread.live, ["solo"]);
  const inverted = acceptRoomCharges({ solo: 8000, single: 7000 }, base);
  assert.deepEqual(inverted.live, [], "Solo can never cost more than Single");
  assert.deepEqual(inverted.charges, base);
});

await check("a fare is basic fare + limited express + berth, per traveller", () => {
  const fare = fareForTrain(config, train("Sunrise Izumo 4031M"), config.fares.roomCharges);
  assert.equal(fare.currency, "JPY");
  assert.equal(fare.classes.singleCabin, 23210, "Tokyo–Izumoshi Single as quoted for 2026");
  assert.equal(fare.classes.twinCabinPerPerson, 15510 + 15400 / 2, "a twin room is per room; two share it");
  assert.equal(fare.classes.nobinobi, 15510 + 530);
  assert.equal(fare.seatClass, "nobinobi");
  assert.equal(fare.fromPrice, fare.classes.nobinobi);
  const seto = fareForTrain(config, train("Sunrise Seto 5032M"), config.fares.roomCharges);
  assert.equal(seto.classes.singleCabin, 22650, "same fare both ways: Tokyo–Takamatsu Single");
  // Every class the source emits has a traveller-facing label.
  for (const key of Object.keys(fare.classes)) assert.ok(FARE_CLASS_LABELS[key], `label for ${key}`);
  assert.equal(fareClassRows(fare)[0].price, "¥16,040");
});

await check("yen is grouped; every other currency prints as before", () => {
  assert.equal(formatMoney(23210, "JPY"), "¥23,210");
  assert.equal(formatMoney(1186, "CNY"), "¥1186");
  assert.equal(formatMoney(53.6, "EUR"), "€53.6");
});

// ─── 4. The adapter, end to end ──────────────────────────────────────────────

function fakeFetch(pages) {
  return async (url) => {
    const key = Object.keys(pages).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(pages[key]);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/html; charset=utf-8" },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
}

async function runAdapter(pages) {
  const written = {};
  const ctx = {
    today: "2026-09-28",
    rootDir: ROOT,
    fetch: fakeFetch(pages),
    write: (file, data) => {
      written[file] = data;
    },
  };
  const quiet = { log: console.log, warn: console.warn };
  console.log = console.warn = () => {};
  let error = null;
  try {
    await run({ ...entry, params: { ...entry.params, seedTimetableIds: [1], requestSpacingMs: 0 } }, ctx);
  } catch (err) {
    error = err;
  } finally {
    Object.assign(console, quiet);
  }
  return { data: written[entry.output], error };
}

await check("the adapter takes what validates, keeps the baseline for the rest, and says which", async () => {
  const guide = entry.params.guidePages[0];
  const tmpl = (id) => entry.params.timetableUrlTemplate.replace("{id}", id).replace(/\?.*$/, "");
  const { data, error } = await runAdapter({
    [guide]: ROOMS_PAGE.replace("7,700円", "7,900円"),
    [tmpl(1)]: IZUMO_WEST_TABLE,
    [tmpl(3841)]: SETO_EAST_LINES,
  });
  assert.equal(error, null);
  const trains = data.trains;
  assert.equal(Object.keys(trains).length, 4);
  assert.equal(trains["Sunrise Izumo 4031M"].timetable.source, "official");
  assert.equal(trains["Sunrise Seto 5032M"].timetable.source, "official");
  assert.equal(trains["Sunrise Izumo 4032M"].timetable.source, "baseline");
  assert.equal(data.checks.timetables["Sunrise Seto 5031M"], "baseline");
  // The page's times replace the baseline's blanks…
  const himeji = trains["Sunrise Izumo 4031M"].stations.find((s) => s.name === "Himeji");
  assert.equal(himeji.departure, "05:26");
  // …and tonight's berth charge prices every train.
  assert.equal(trains["Sunrise Izumo 4031M"].fare.classes.singleCabin, 15510 + 7900);
  assert.equal(trains["Sunrise Izumo 4031M"].fare.sampledAt, "2026-09-28");
  assert.equal(trains["Sunrise Izumo 4031M"].agency_id, "JRW");
  assert.ok(polyline.decode(trains["Sunrise Seto 5031M"].polyline).length > 12);
});

await check("a night where nothing validates still writes the trains, then fails loudly", async () => {
  const { data, error } = await runAdapter({});
  assert.ok(data?.trains?.["Sunrise Izumo 4031M"], "the map keeps the train");
  assert.equal(data.trains["Sunrise Izumo 4031M"].timetable.source, "baseline");
  assert.equal(data.trains["Sunrise Izumo 4031M"].fare.sampledAt, config.fares.checkedAt, "no false 'checked tonight'");
  assert.match(String(error?.message), /no JR page confirmed/);
});

// ─── 5. The booking guide ────────────────────────────────────────────────────

await check("the Sunrise guide resolves for JR West, compound ids included, and nobody else", () => {
  assert.equal(getBookingGuide({ agencyId: "JRW" })?.id, "sunrise");
  assert.equal(getBookingGuide({ agencyId: "JRC/JRW" })?.id, "sunrise");
  assert.equal(getBookingGuide({ agencyIds: ["ÖBB", "JRW"] })?.id, "sunrise");
  assert.equal(getBookingGuide({ agencyId: "ÖBB" }), null);
  assert.equal(getBookingGuide({}), null);
  assert.equal(bookingGuideFor(null, { agencyId: "JRW" }), null);
});

await check("the guide carries the purchase quirks it exists for", () => {
  const guide = guideProps(getBookingGuide({ agencyId: "JRW" }));
  const text = JSON.stringify(guide);
  assert.match(text, /10:00 (Japan time|JST)/, "the sale time");
  assert.match(text, /one month/i);
  assert.match(text, /1 adult/, "twin rooms are booked for one adult");
  assert.match(text, /basic-fare ticket/i, "the second traveller's own ticket");
  assert.match(text, /4-digit PIN/);
  assert.match(text, /Osaka/, "which direction stops in Osaka");
  assert.ok(guide.highlights.length >= 3 && guide.sections.length >= 4);
  for (const s of [...guide.sources, ...guide.furtherReading]) {
    assert.match(s.url, /^https:\/\//, `${s.label} is a real link`);
  }
  assert.match(guide.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
});

await check("the guide rests on JR's own pages and credits the traveller's post without retelling it", () => {
  const guide = guideProps(getBookingGuide({ agencyId: "JRW" }));
  const host = (url) => new URL(url).hostname;
  // What the guide states is sourced from the operator (and one reference page
  // for the rail pass); a forum post is linked for readers, never used as a source.
  assert.ok(guide.sources.some((s) => /(^|\.)(jr-odekake\.net|westjr\.co\.jp)$/.test(host(s.url))));
  for (const s of guide.sources) {
    assert.ok(!/reddit\.com$/.test(host(s.url)), `${s.label} is a forum post listed as a source`);
  }
  assert.ok(
    guide.furtherReading.some((s) => s.url.includes("reddit.com/r/JapanTravel/comments/1d62gqb")),
    "the traveller's guide the booking section was prompted by is credited and linked",
  );
  // The retelling this replaced: that traveller's own prices and anecdotes.
  const text = JSON.stringify({ ...guide, sources: [], furtherReading: [] });
  assert.doesNotMatch(text, /21,320|8,910|smoking/i, "one traveller's own story stays theirs");
});

await check("the guide folds into a page's FAQ without duplicating a question", () => {
  const guide = getBookingGuide({ agencyId: "JRW" });
  const base = [
    { q: "How long does the Tokyo to Izumo night train take?", a: "About 12h." },
    { q: "How do I book a night train from Tokyo to Izumo?", a: "Compare the trains above and book directly with JR West." },
  ];
  const faq = withBookingGuideFaq(base, guide);
  assert.equal(faq[1].a, guide.bookingAnswer, "the generic answer becomes the specific one");
  assert.equal(faq.length, base.length + guide.faq.length);
  assert.equal(new Set(faq.map((f) => f.q)).size, faq.length);
  assert.equal(withBookingGuideFaq(faq, guide).length, faq.length, "idempotent");
  assert.deepEqual(withBookingGuideFaq(base, null), base);
  for (const f of BOOKING_GUIDES.guides.sunrise.faq) assert.ok(f.q.endsWith("?") && f.a.length > 40);
});

await check("Baku–Tbilisi: the entry restriction reaches the train, from official sources, in our own words", () => {
  const guide = guideProps(getBookingGuide({ agencyId: "ADY" }));
  assert.equal(guide?.id, "baku-tbilisi");
  const host = (url) => new URL(url).hostname;
  assert.match(guide.panelTitle, /who can cross the border/, "the panel box names the restriction, not ticketing");
  assert.equal(guideProps(getBookingGuide({ agencyId: "JRW" })).panelTitle, "", "Sunrise keeps the default box title");
  const text = JSON.stringify({ ...guide, sources: [], furtherReading: [] });
  assert.match(text, /visa-free/);
  assert.match(text, /e-visa/);
  assert.ok(guide.sources.length && guide.sources.every((s) => host(s.url) === "migration.gov.az"));
  assert.ok(guide.furtherReading.some((s) => host(s.url) === "wander-lush.org"), "the travel blog is credited, not retold");
  assert.doesNotMatch(text, /will not be permitted to pass through border checkpoints/, "no quoted sentence from the blog");
  const faq = withBookingGuideFaq([], getBookingGuide({ agencyId: "ADY" }));
  assert.ok(faq.some((f) => /e-visa/.test(f.q)));
  for (const f of faq) assert.ok(f.q.endsWith("?") && f.a.length > 40);
  // Every line must be true of every route it applies to: ADY runs this one route.
  const published = readJson("public/data/published/initial-data.json");
  const adyRoutes = Object.values(published.data.viewMap).filter((r) =>
    /\bADY\b/.test(`${r.bot_agency_id || ""} ${r.agency_id || ""}`),
  );
  assert.deepEqual(adyRoutes.map((r) => r.route_long_name), ["Baku – Tbilisi"]);
});

// ─── 6. What the pipeline published ──────────────────────────────────────────

await check("the published payload carries both routes, priced, with their stations", () => {
  const published = readJson("public/data/published/initial-data.json");
  const payload = published.data ?? published;
  const izumo = payload.viewMap.jr_Sunrise_Izumo_4031M;
  const seto = payload.viewMap.jr_Sunrise_Seto_5031M;
  for (const row of [izumo, seto]) {
    assert.ok(row, "route row present");
    assert.equal(row.agency_id, "JRW");
    assert.equal(row.timetable_source, "jr-sunrise");
    assert.equal(row.pricing?.currency, "JPY");
    assert.equal(row.pricing?.type, "fixed");
    assert.ok(row.nj_polyline_0 && row.nj_polyline_1);
    assert.equal(row.service_id_0, "Daily");
  }
  assert.equal(izumo.trip_short_name_1, "Sunrise Izumo 4032M", "the two directions pair into one route");
  assert.match(izumo.via_1, /Osaka/);
  assert.doesNotMatch(izumo.via_0, /Osaka/);
  const names = new Set(payload.stops.map((s) => s.stop_name));
  for (const s of config.stations) assert.ok(names.has(s.name), `${s.name} is on the map`);
});

await check("the endpoints resolve to cities, so the connection pages read Tokyo–Izumo", () => {
  assert.equal(cityForStation("Izumoshi"), "Izumo");
  assert.equal(cityForStation("Sannomiya"), "Kobe");
  assert.equal(cityForStation("Tokyo"), "Tokyo");
  assert.equal(cityForStation("Takamatsu"), "Takamatsu");
});

console.log(`\n[verify-jr-sunrise] ${checks} checks passed`);
