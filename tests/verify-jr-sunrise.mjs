// tests/verify-jr-sunrise.mjs
// The Sunrise Izumo / Sunrise Seto source (scripts/lib/jr-sunrise.mjs,
// scripts/adapters/jr-sunrise.mjs) and the booking guide it ships with.
//
// The timetable is read from JR West's own Sunrise PDF. Its layout is pinned by
// tests/fixtures/jr-sunrise/jikokuhyo-lines.mjs — the positioned lines the
// "Probe JR Sunrise source" workflow printed from the live file on 2026-10-19,
// with the committed baseline's times. The berth-charge page fixture is still
// synthetic: the live guide page prints no berth charge (same probe run).
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
  extractLinks,
  fareForTrain,
  htmlSegments,
  makeStationMatcher,
  normalizeStationName,
  parseRoomCharges,
  pdfColumns,
  pdfTime,
  timetablesFromPdf,
  trainPath,
  validateConfig,
} from "../scripts/lib/jr-sunrise.mjs";
import { decodeBody, run } from "../scripts/adapters/jr-sunrise.mjs";
import { pdfLines } from "../scripts/lib/pdf-lines.mjs";
import { JIKOKUHYO_LINES } from "./fixtures/jr-sunrise/jikokuhyo-lines.mjs";
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

const ROOMS_PAGE = `
<table>
<tr><th>設備</th><th>寝台料金</th></tr>
<tr><td>シングルデラックス</td><td>13,980円</td></tr>
<tr><td>サンライズツイン<br>(1室2名)</td><td>15,400円</td></tr>
<tr><td>シングルツイン</td><td>9,600円</td><td>(2名利用時 追加 5,500円)</td></tr>
<tr><td>シングル</td><td>7,700円</td></tr>
<tr><td>ソロ</td><td>6,600円</td></tr>
<tr><td>ノビノビ座席</td><td>寝台料金不要</td></tr>
</table>`;

// ─── 1. The committed baseline ───────────────────────────────────────────────

await check("the config is structurally sound and the registry accepts the entry", () => {
  assert.deepEqual(validateConfig(config), []);
  assert.ok(entry, "registry has a jr-sunrise entry");
  assert.deepEqual(validateRegistry(registry), []);
  assert.equal(entry.official, true);
  assert.equal(entry.params.configPath, "data/sources/jr-sunrise.json");
  assert.match(entry.params.timetablePdf, /^https:\/\/www\.jr-odekake\.net\/.+\.pdf$/);
  assert.equal(entry.endpoint, entry.params.timetablePdf, "the dashboard prints the address the adapter reads");
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

// ─── 2. Reading the timetable PDF ─────────────────────────────────────────────

await check("names fold the way JR writes them", () => {
  assert.equal(normalizeStationName("Izumo-Shi"), normalizeStationName("Izumoshi"));
  assert.equal(normalizeStationName("岡山駅"), normalizeStationName("岡山"));
  assert.equal(normalizeStationName("三ノ宮(JR)"), normalizeStationName("三ノ宮"));
  assert.equal(matchStation("Bicchu-Takahashi"), "bitchu-takahashi");
  assert.equal(matchStation("富士"), "fuji");
  assert.equal(matchStation("富士川"), null, "a station name inside another is not that station");
});

const clone = () => structuredClone(JIKOKUHYO_LINES);
const at = (stops) => Object.fromEntries(stops.map((s) => [s.station, s]));
const withoutRow = (pages, x0, firstChar) =>
  pages.map((lines) =>
    lines.map((l) => {
      const start = l.cells.findIndex((c) => c.x === x0 && c.text === firstChar);
      if (start < 0) return l;
      const end = x0 < 200 ? 200 : Infinity;
      return { ...l, cells: l.cells.filter((c) => c.x < x0 - 2 || c.x >= end) };
    }),
  );

await check("a PDF time is three or four digits, and nothing else is", () => {
  assert.equal(pdfTime("2126"), "21:26");
  assert.equal(pdfTime("054"), "00:54");
  assert.equal(pdfTime("1000"), "10:00");
  for (const glyph of ["a", "e", "g", "c", "12", "", null]) assert.equal(pdfTime(glyph), null, `${glyph} is not a time`);
});

await check("JR West's PDF yields all four trains, each from its own column", () => {
  const { timetables, problems, columns } = timetablesFromPdf(JIKOKUHYO_LINES, config, matchStation);
  assert.equal(columns, 4);
  assert.deepEqual(problems, {});
  const used = Object.values(timetables).map((t) => t.column);
  assert.equal(new Set(used).size, 4, "no column stands for two trains");

  const izumoWest = at(timetables["Sunrise Izumo 4031M"].stops);
  assert.equal(izumoWest.tokyo.departure, "21:26");
  assert.equal(izumoWest.hamamatsu.departure, "00:54", "a three-digit time is past midnight");
  // From 大阪 着 on, the left table's times are arrivals, carried down by 〃.
  assert.deepEqual([izumoWest.himeji.arrival, izumoWest.himeji.departure], ["05:25", null]);
  assert.equal(izumoWest.okayama.arrival, "06:27");
  assert.equal(izumoWest.izumoshi.arrival, "10:00");

  const setoWest = at(timetables["Sunrise Seto 5031M"].stops);
  assert.equal(setoWest.kojima.arrival, "06:52");
  assert.deepEqual([setoWest.takamatsu.arrival, setoWest.takamatsu.departure], ["07:27", null]);

  const setoEast = at(timetables["Sunrise Seto 5032M"].stops);
  assert.deepEqual([setoEast.takamatsu.arrival, setoEast.takamatsu.departure], [null, "21:26"]);
  assert.equal(setoEast.osaka.departure, "00:33");
  assert.equal(setoEast.tokyo.arrival, "07:08");

  const izumoEast = at(timetables["Sunrise Izumo 4032M"].stops);
  assert.equal(izumoEast.izumoshi.departure, "18:57");
  assert.equal(izumoEast.okayama.departure, "22:34");
});

await check("a column's header does not name its train — the stops do", () => {
  // The Izumo column is headed 5031M, the number it runs under coupled to the
  // Seto as far as Okayama; trusting the header would give the Izumo the Seto.
  const columns = pdfColumns(JIKOKUHYO_LINES, matchStation);
  assert.deepEqual(columns.map((c) => c.header), ["5031M", "5031M", "5032M", "5032M"]);
  const { timetables } = timetablesFromPdf(JIKOKUHYO_LINES, config, matchStation);
  assert.equal(timetables["Sunrise Izumo 4031M"].stops.at(-1).station, "izumoshi");
  assert.equal(timetables["Sunrise Seto 5031M"].stops.at(-1).station, "takamatsu");
});

await check("a missing stop, a moved train or a PDF with no table is refused, train by train", () => {
  // 米子 gone from the left table: the westbound Izumo is refused, the Seto is not.
  const noYonago = timetablesFromPdf(withoutRow(clone(), 14, "米"), config, matchStation);
  assert.match(noYonago.problems["Sunrise Izumo 4031M"].join(), /yonago not found/);
  assert.ok(noYonago.timetables["Sunrise Seto 5031M"], "a train the edit does not touch still validates");

  // Leaving Tokyo two hours earlier on the left: another train's times, not a retiming.
  const earlier = clone();
  for (const line of earlier[0]) for (const c of line.cells) if (c.x < 200 && c.text === "2126") c.text = "1926";
  const drift = timetablesFromPdf(earlier, config, matchStation);
  assert.match(drift.problems["Sunrise Izumo 4031M"].join(), /tokyo departure 19:26 is 120 min from the baseline/);
  assert.ok(drift.timetables["Sunrise Seto 5032M"], "the right table is unaffected");
  assert.ok(MAX_DRIFT_MINUTES >= 30, "a real retiming (24 min in March 2026) must still pass");

  const empty = timetablesFromPdf([[{ y: 10, cells: [{ x: 10, text: "お知らせ" }] }]], config, matchStation);
  assert.deepEqual(Object.keys(empty.timetables), []);
  assert.deepEqual(empty.problems["Sunrise Izumo 4031M"], ["no timetable columns in the PDF"]);
});

await check("a PDF's text comes back as positioned lines, top to bottom", async () => {
  // A one-page PDF built here: two text runs on one baseline, one below.
  const stream = "BT /F1 12 Tf 20 150 Td (Tokyo) Tj 80 0 Td (2126) Tj ET BT /F1 12 Tf 20 120 Td (Okayama) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pages = await pdfLines(Buffer.from(body, "latin1"));
  assert.deepEqual(pages, [
    [
      { y: 50, cells: [{ x: 20, text: "Tokyo" }, { x: 100, text: "2126" }] },
      { y: 80, cells: [{ x: 20, text: "Okayama" }] },
    ],
  ]);
});

await check("links are read with their anchor text, made absolute", () => {
  const links = extractLinks(
    '<a href="pdf/jikokuhyo.pdf"><span>ファイル</span>ダウンロード</a><a href="#top">x</a>',
    "https://www.jr-odekake.net/railroad/train/sunriseseto_izumo/",
  );
  assert.deepEqual(links, [
    { href: "https://www.jr-odekake.net/railroad/train/sunriseseto_izumo/pdf/jikokuhyo.pdf", text: "ファイル ダウンロード" },
  ]);
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

// The PDF arrives as bytes the fake fetch serves; `readPdf` stands in for
// pdf-lines (whose own reading is checked above) and hands over the lines.
async function runAdapter(pages, pdfPages = null) {
  const written = {};
  const ctx = {
    today: "2026-09-28",
    rootDir: ROOT,
    fetch: fakeFetch(pages),
    readPdf: async () => pdfPages,
    write: (file, data) => {
      written[file] = data;
    },
  };
  const quiet = { log: console.log, warn: console.warn };
  console.log = console.warn = () => {};
  let error = null;
  try {
    await run({ ...entry, params: { ...entry.params, requestSpacingMs: 0 } }, ctx);
  } catch (err) {
    error = err;
  } finally {
    Object.assign(console, quiet);
  }
  return { data: written[entry.output], error };
}

await check("the adapter takes what validates, keeps the baseline for the rest, and says which", async () => {
  const guide = entry.params.guidePages[0];
  // The eastbound Izumo's first stop is gone from this copy, so it alone keeps the baseline.
  const { data, error } = await runAdapter(
    { [guide]: ROOMS_PAGE.replace("7,700円", "7,900円"), [entry.params.timetablePdf]: "%PDF-1.4" },
    withoutRow(clone(), 235, "出 雲 市"),
  );
  assert.equal(error, null);
  const trains = data.trains;
  assert.equal(Object.keys(trains).length, 4);
  for (const name of ["Sunrise Izumo 4031M", "Sunrise Seto 5031M", "Sunrise Seto 5032M"]) {
    assert.equal(trains[name].timetable.source, "official", name);
    assert.equal(data.checks.timetables[name], entry.params.timetablePdf);
  }
  assert.equal(trains["Sunrise Izumo 4032M"].timetable.source, "baseline");
  assert.equal(data.checks.timetables["Sunrise Izumo 4032M"], "baseline");
  // The PDF's times replace the baseline's blanks…
  const himeji = trains["Sunrise Izumo 4031M"].stations.find((s) => s.name === "Himeji");
  assert.equal(himeji.arrival, "05:25");
  // …and tonight's berth charge prices every train.
  assert.equal(trains["Sunrise Izumo 4031M"].fare.classes.singleCabin, 15510 + 7900);
  assert.equal(trains["Sunrise Izumo 4031M"].fare.sampledAt, "2026-09-28");
  assert.equal(trains["Sunrise Izumo 4031M"].agency_id, "JRW");
  assert.ok(polyline.decode(trains["Sunrise Seto 5031M"].polyline).length > 12);
});

await check("a night where nothing validates still writes the trains, then fails loudly", async () => {
  const { data, error } = await runAdapter({});
  assert.ok(data?.trains?.["Sunrise Izumo 4031M"], "the map keeps the train");
  assert.match(String(error?.message), /no JR source confirmed/);
  // A PDF that is not one is a log line, not a crash.
  const broken = await runAdapter({ [entry.params.timetablePdf]: "<html>" }, null);
  assert.equal(broken.data.trains["Sunrise Seto 5031M"].timetable.source, "baseline");
});

await check("a night with no PDF keeps every train on the baseline", async () => {
  const { data, error } = await runAdapter({});
  assert.ok(data?.trains?.["Sunrise Izumo 4031M"], "the map keeps the train");
  assert.equal(data.trains["Sunrise Izumo 4031M"].timetable.source, "baseline");
  assert.equal(data.trains["Sunrise Izumo 4031M"].fare.sampledAt, config.fares.checkedAt, "no false 'checked tonight'");
  assert.match(String(error?.message), /no JR source confirmed/);
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
