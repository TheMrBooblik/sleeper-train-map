// tests/verify-vnr.mjs
// Vietnam Railways night trains (scripts/lib/vnr.mjs, scripts/adapters/vnr.mjs).
//
// The page readers run against answers giotaugiave.dsvn.vn gave the probe
// (tests/fixtures/vnr, ViewState trimmed); the rest against small tables
// built here. Run: node tests/verify-vnr.mjs

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  berthClass,
  berthFares,
  buildVnrTrains,
  clock,
  dropDuplicateTimetables,
  frequencyFor,
  fareRecord,
  formFields,
  isNightTrain,
  journeyMinutes,
  nightsOf,
  pairOrder,
  parseAspForm,
  parseFares,
  parseTimetable,
  selectNamed,
  stationKey,
  stationPositions,
} from "../scripts/lib/vnr.mjs";
import { FARE_CLASS_LABELS, formatMoney } from "../src/lib/fareClasses.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "tests/fixtures/vnr");
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fixture = (name) => {
  const file = path.join(FIX, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

// A timetable answer in the site's shape: "Ga đi | Cự ly | Ngày đi | Giờ đi | Giờ đến",
// departure BEFORE arrival, clocks sometimes unpadded ("22:7").
const ttHtml = (rows) =>
  `<table><tr><th>Ga đi</th><th>Cự ly</th><th>Ngày đi</th><th>Giờ đi</th><th>Giờ đến</th></tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</table>`;

console.log("timetable answers");
{
  const tt = parseTimetable(
    ttHtml([
      ["H&#224; Nội", 0, "22-10-2026", "21:45", "21:45"],
      ["Ninh Bình", 115, "23-10-2026", "0:3", "0:0"],
      ["Đà Nẵng", 791, "23-10-2026", "13:29", "13:14"],
      ["Sài Gòn", 1726, "24-10-2026", "6:30", "6:30"],
    ]),
  );
  check("reads every row, entities decoded and clocks padded", tt?.stops.length === 4 && tt.stops[0].name === "Hà Nội" && tt.stops[1].departure === "00:03" && tt.stops[1].arrival === "00:00");
  check("departure is the first clock column, arrival the second", tt.stops[2].departure === "13:29" && tt.stops[2].arrival === "13:14");
  check("a 33-hour train keeps its length (SE1: 32h45, two nights)", journeyMinutes(tt) === 32 * 60 + 45 && nightsOf(tt) === 2);
  // A stop arrived at before midnight and left after it carries its departure's date.
  const late = parseTimetable(ttHtml([["A", 0, "22-10-2026", "22:00", "22:00"], ["B", 50, "23-10-2026", "0:05", "23:58"], ["C", 300, "23-10-2026", "6:00", "6:00"]]));
  check("an arrival later in the day than its departure was the evening before", late.stops[1].arrMinutes === 118 && late.stops[1].depMinutes === 125);
  check("a page without a timetable table reads as nothing, not as no stops", parseTimetable("<table><tr><td>Loại chỗ</td></tr></table>") === null && parseTimetable("") === null);
  check("a timetable that runs backwards is a misread, not a train", parseTimetable(ttHtml([["A", 0, "22-10-2026", "22:00", "22:00"], ["B", 50, "22-10-2026", "21:00", "21:00"]])) === null);
  check("clock() refuses what is not a clock", clock("25:00") === null && clock("7:5") === "07:05" && clock("") === null);
}

console.log("which trains are night trains");
{
  const day = parseTimetable(ttHtml([["Hà Nội", 0, "22-10-2026", "6:00", "6:00"], ["Hải Phòng", 102, "22-10-2026", "8:25", "8:25"]]));
  const na = parseTimetable(ttHtml([["Hà Nội", 0, "22-10-2026", "22:45", "22:45"], ["Vinh", 319, "23-10-2026", "5:35", "5:35"]]));
  const hop = parseTimetable(ttHtml([["Phan Thiết", 0, "22-10-2026", "23:50", "23:50"], ["Bình Thuận", 10, "23-10-2026", "0:20", "0:20"]]));
  const se21 = parseTimetable(ttHtml([["Đà Nẵng", 0, "22-10-2026", "7:55", "7:55"], ["Sài Gòn", 935, "23-10-2026", "4:35", "4:35"]]));
  const opts = { minMinutes: 300, exclude: ["MR1"] };
  check("a day train is not", !isNightTrain(day, opts, "HP1"));
  check("an overnight train of 6h50 is (NA1 Hà Nội–Vinh)", isNightTrain(na, opts, "NA1"));
  check("a half-hour hop across midnight is not", !isNightTrain(hop, opts, "BT61"));
  check("a morning departure arriving next morning is (SE21)", isNightTrain(se21, opts, "SE21"));
  check("an excluded number is not", !isNightTrain(na, opts, "MR1"));
}

console.log("fares");
{
  const rows = [
    { code: "AnLT1", label: "Tầng 1, khoang có 4 giường", price: 2096000 },
    { code: "AnLT1M", label: "Tầng 1, khoang có 4 giường", price: 2243000 },
    { code: "AnLT2", label: "Tầng 2, khoang có 4 giường", price: 1952000 },
    { code: "AnLv2", label: "Khoang có 2 giường", price: 3144000 },
    { code: "AnLv2M", label: "Khoang có 2 giường VIP", price: 4486000 },
    { code: "BnLT1", label: "Tầng 1, khoang có 6 giường", price: 1946000 },
    { code: "BnLT2", label: "Tầng 2, khoang có 6 giường", price: 1732000 },
    { code: "BnLT3", label: "Tầng 3, khoang có 6 giường", price: 1572000 },
    { code: "BnT3", label: "Tầng 3, khoang có 6 giường", price: 1300000 },
    { code: "GP", label: "Ghế phụ", price: 929000 },
    { code: "NML", label: "Ngồi mềm", price: 1161000 },
    { code: "AnL", label: "Vé nằm LVQT tầng 1", price: 5000000 },
  ];
  const classes = berthFares(rows);
  check("berths only: no seat, no folding seat, no international through-car berth", !Object.values(classes).includes(929000) && !Object.values(classes).includes(1161000) && !Object.values(classes).includes(5000000));
  check("cheapest per class (the newer M coach costs more)", classes.vnrSoft4Lower === 2096000 && classes.vnrSoft4Upper === 1952000);
  check("2-berth and VIP 2-berth are their own classes", classes.vnrSoft2 === 3144000 && classes.vnrSoft2Vip === 4486000);
  check("6-berth tiers bottom → top", classes.vnrHard6Lower === 1946000 && classes.vnrHard6Middle === 1732000 && classes.vnrHard6Upper === 1572000);
  check("a coach without air-con is its own class", classes.vnrHard6UpperFan === 1300000 && berthClass({ code: "AnLT1", label: "Tầng 1, khoang có 4 giường" }) === "vnrSoft4Lower");
  check("every class it can produce has a traveller-facing label", Object.keys(classes).every((k) => FARE_CLASS_LABELS[k]));
  const rec = fareRecord(classes, { sampledAt: "2026-10-21", travelDate: "2026-10-28" });
  check("the record's from-price is its cheapest berth, in VND", rec.fromPrice === 1300000 && rec.currency === "VND" && rec.seatClass === "vnrHard6UpperFan");
  check("a train selling no berth has no fare", fareRecord(berthFares([{ code: "NML", label: "Ngồi mềm", price: 100 }]), {}) === null);
  check("dong print grouped", formatMoney(2096000, "VND") === "₫2,096,000");
  const page = `<table><tr><td></td><td>Loại chỗ</td><td>Giá vé</td></tr><tr><td>AnLT1</td><td>Tầng 1, khoang c&#243; 4 giường</td><td>2.096.000 ₫</td></tr><tr><td></td><td>(Giá vé trên đã bao gồm bảo hiểm và thuế giá trị gia tăng)</td><td></td></tr></table>`;
  check("a fare answer reads as code, label and price; the footnote row is skipped", eq(parseFares(page), [{ code: "AnLT1", label: "Tầng 1, khoang có 4 giường", price: 2096000 }]));
}

console.log("forms");
{
  const html = `<form method="post" action="./thongnhat.aspx"><input type="hidden" name="__VIEWSTATE" value="abc" />
    <input name="ctl00$ContentPlaceHolderMain$txtNgayDi" type="text" value="22-10-2026" />
    <select name="ctl00$ContentPlaceHolderMain$ddlChieu"><option selected="selected" value="1">Chiều đi</option><option value="0">Chiều về</option></select>
    <select name="ctl00$ContentPlaceHolderMain$ddlMacTau"><option selected="selected" value="9175">SE1</option><option value="9178">SE5</option></select>
    <input type="submit" name="ctl00$ContentPlaceHolderMain$btnTraTim" value="Tra tìm" />
    <input name="ctl00$LoginView1$Login2$UserName" type="text" /></form>`;
  const form = parseAspForm(html);
  check("selects and options read", selectNamed(form, "ddlMacTau").options.map((o) => o.text).join() === "SE1,SE5");
  const fields = formFields(form, { ddlMacTau: "9178", txtNgayDi: "28-10-2026", search: true });
  check("a postback carries the state, the choices and the search button — never the login box", fields.__VIEWSTATE === "abc" && fields["ctl00$ContentPlaceHolderMain$ddlMacTau"] === "9178" && fields["ctl00$ContentPlaceHolderMain$txtNgayDi"] === "28-10-2026" && fields["ctl00$ContentPlaceHolderMain$btnTraTim"] === "Tra tìm" && !Object.keys(fields).some((k) => /Login/.test(k)));
  check("without search: no button", !("ctl00$ContentPlaceHolderMain$btnTraTim" in formFields(form)));
}

console.log("pairs, names and positions");
{
  check("odd n with n+1, prefix by prefix", eq(pairOrder(["SE2", "SE1", "SNT2", "SNT1", "SE19", "SE20", "SE21", "NA2", "NA1"]), ["NA1", "NA2", "SE1", "SE2", "SE19", "SE20", "SE21", "SNT1", "SNT2"]));
  check("an even train whose partner is not running stands alone", eq(pairOrder(["SP4"]), ["SP4"]));
  check("station keys fold diacritics, Đ and the 'Ga' prefix", stationKey("Ga Đồng Hới") === stationKey("Đồng Hới") && stationKey("Đồng Hới") === "dong hoi" && stationKey("Hanoi Railway Station") === "hanoi");
  const anchors = { "Hà Nội": { lat: 21.0245, lon: 105.8412 }, Vinh: { lat: 18.6828, lon: 105.6735 } };
  const trains = [[{ name: "Hà Nội", km: 0 }, { name: "Thanh Hoá", km: 175 }, { name: "Vinh", km: 319 }]];
  const noOsm = stationPositions(trains, anchors, null);
  const th = noOsm.get("Thanh Hoá");
  check("a station with no anchor sits between its anchored neighbours by kilometre post", th.source === "interpolated" && Math.abs(th.lat - (21.0245 + (18.6828 - 21.0245) * (175 / 319))) < 1e-9);
  const osm = [["Ga Thanh Hóa", "Ga Thanh Hóa", null, 19.7966, 105.7682], ["Vinh", null, null, 30.0, 110.0]];
  const withOsm = stationPositions(trains, anchors, osm);
  check("OSM's station of the same name near where we expect it wins", withOsm.get("Thanh Hoá").source === "osm" && withOsm.get("Thanh Hoá").lat === 19.7966);
  check("a namesake far away is not taken", withOsm.get("Vinh").source === "anchor");
}

console.log("the trains file");
{
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/vnr-sleepers.json"), "utf8"));
  const tt = (rows) => parseTimetable(ttHtml(rows));
  const se1 = tt([["Hà Nội", 0, "28-10-2026", "21:45", "21:45"], ["Vinh", 319, "29-10-2026", "3:28", "3:21"], ["Sài Gòn", 1726, "30-10-2026", "6:30", "6:30"]]);
  const se2 = tt([["Sài Gòn", 0, "28-10-2026", "20:35", "20:35"], ["Vinh", 1407, "29-10-2026", "22:00", "21:50"], ["Hà Nội", 1726, "30-10-2026", "5:42", "5:42"]]);
  const positions = stationPositions([se1.stops, se2.stops], config.anchors, null);
  const found = new Map([
    ["SE2", { timetable: se2, fare: null }],
    ["SE1", { timetable: se1, fare: { fromPrice: 1572000, currency: "VND", classes: { vnrHard6Upper: 1572000 } } }],
  ]);
  const trains = buildVnrTrains({ config, found, positions, today: "2026-10-21", travelDate: "2026-10-28" });
  const t = trains.SE1;
  check("written in pair order", eq(Object.keys(trains), ["SE1", "SE2"]));
  check("each stop is dated: SE1 reaches Sài Gòn two days after it leaves", t.stations.at(-1).arrivalDay === 2 && t.stations[0].departureDay === 0 && t.stations[1].arrivalDay === 1);
  check("the journey time is stated outright (32h45), not left to two clocks", t.durationMinutes === 32 * 60 + 45 && t.nights === 2);
  check("daily where the config says so, VNR", t.frequency === "Daily" && t.agency_id === "VNR");
  check("first stop has no arrival, last no departure", t.stations[0].arrival === null && t.stations.at(-1).departure === null);
  check("a line through every stop", polyline.decode(t.polyline).length >= 3);
  // Tonight's read failed for SE2: last night's entry is carried.
  const carried = buildVnrTrains({
    config,
    found: new Map([["SE1", found.get("SE1")]]),
    carry: new Set(["SE2"]),
    positions,
    previous: { SE2: { ...trains.SE2, timetable: { source: "official", checkedAt: "2026-10-20" } } },
    today: "2026-10-21",
    travelDate: "2026-10-28",
  });
  check("a train the site listed but did not answer for keeps last night's entry", carried.SE2?.timetable.source === "previous");
  const stale = buildVnrTrains({ config, found: null, positions, previous: { SE2: { ...trains.SE2, timetable: { checkedAt: "2026-09-01" } } }, today: "2026-10-21" });
  check("…but not one nobody has confirmed for over 30 days", !stale.SE2);
  check("a train the config does not list as daily keeps no frequency (unknown, never a guessed Daily)", frequencyFor(config, "SE23") === null && frequencyFor(config, "SE1") === "Daily");
  const dupes = dropDuplicateTimetables(
    new Map([
      ["SE17", { timetable: se1, fare: null }],
      ["JSE17", { timetable: se1, fare: { fromPrice: 1 } }],
      ["SE2", { timetable: se2, fare: null }],
    ]),
  );
  check("one train sold under two numbers is kept once — the number with fares", eq([...dupes.keys()], ["JSE17", "SE2"]));
}

console.log("registry and wiring");
{
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
  const entry = registry.find((e) => e.id === "vnr");
  check("registry entry: enabled, official, agency VNR, prefix vnr_, service days on", entry?.enabled && entry.official && entry.synthetic?.idPrefix === "vnr_" && entry.agencyDefaults?.agencyId === "VNR" && entry.synthetic.withService);
  check("its endpoint is VNR's own site", entry.endpoint === entry.params.baseUrl && /giotaugiave\.dsvn\.vn/.test(entry.endpoint));
  check("the probe workflow exists", fs.existsSync(path.join(ROOT, ".github/workflows/probe-vnr.yml")));
  const { OPERATORS } = await import("../src/lib/seo/operatorNames.mjs");
  const { OPERATOR_COUNTRY_FALLBACK } = await import("../src/lib/seo/countries.js").catch(() => ({}));
  check("operator named, with a hub slug", OPERATORS.VNR?.slug === "vietnam-railways");
  if (OPERATOR_COUNTRY_FALLBACK) check("its stations are Vietnam's", eq(OPERATOR_COUNTRY_FALLBACK.VNR, ["VN"]));
  const { cityForStation } = await import("../src/lib/seo/cities.mjs");
  check("termini resolve to the English city a traveller searches for", cityForStation("Hà Nội") === "Hanoi" && cityForStation("Sài Gòn") === "Ho Chi Minh City" && cityForStation("Đà Nẵng") === "Da Nang" && cityForStation("Lào Cai") === "Lao Cai");
}

console.log("real answers (tests/fixtures/vnr, captured 2026-10-21 for travel on 2026-10-28)");
{
  const se4 = fixture("giotau-saigon-return.html");
  if (!se4) {
    check("fixtures present", false, "run the probe and save its FIXTURE blocks");
  } else {
    const tt = parseTimetable(se4);
    check("SE4's live timetable reads end to end, 23 stops", tt?.stops[0].name === "Sài Gòn" && tt.stops.at(-1).name === "Hà Nội" && tt.stops.length === 23);
    check("…as a two-night journey of 33h16", nightsOf(tt) === 2 && journeyMinutes(tt) === 33 * 60 + 16);
    check("…with its kilometre posts", tt.stops[0].km === 0 && tt.stops.at(-1).km === 1726);
    const form = parseAspForm(se4);
    check("the answer's form is the return direction's, listing its trains", selectNamed(form, "ddlChieu").options.find((o) => o.selected)?.value === "0" && selectNamed(form, "ddlMacTau").options.some((o) => o.text === "SE4") && selectNamed(form, "ddlMacTau").options.some((o) => o.text === "SNT2"));
    const fields = formFields(form, { ddlMacTau: "x", search: true });
    check("its postback carries the trimmed state and the search button", "__VIEWSTATE" in fields && Object.keys(fields).some((k) => k.endsWith("btnTraTim")));
  }
  const fares = fixture("giave-thongnhat-SE1.html");
  if (fares) {
    const rows = parseFares(fares);
    const classes = berthFares(rows);
    check("SE1's live fare table reads: 21 places, 7 berth classes", rows?.length === 21 && Object.keys(classes).length === 7);
    check("…a lower berth costs more than the one above it", classes.vnrSoft4Lower > classes.vnrSoft4Upper && classes.vnrHard6Lower > classes.vnrHard6Middle && classes.vnrHard6Middle > classes.vnrHard6Upper);
    check("…the cheapest berth is the top of a 6-berth cabin, ₫1,246,000", fareRecord(classes, {}).fromPrice === 1246000 && fareRecord(classes, {}).seatClass === "vnrHard6Upper");
    check("…and the legend table beside it (place codes, no prices) is not read as fares", rows.every((r) => r.price > 100000));
  }
  const laocai = fixture("giotau-laocai-get.html");
  if (laocai) {
    const form = parseAspForm(laocai);
    check("the Lào Cai line page lists its SP trains", eq(selectNamed(form, "ddlMacTau")?.options.map((o) => o.text), ["SP15", "SP7", "SP3"]));
    check("…and a page without a search answer has no timetable", parseTimetable(laocai) === null);
  }
}

if (failures) {
  console.error(`\nverify-vnr: ${failures} problem(s)`);
  process.exit(1);
}
console.log("\nverify-vnr: all checks passed");
