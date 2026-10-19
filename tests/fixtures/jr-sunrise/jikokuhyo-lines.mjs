// JR West's Sunrise timetable PDF (railroad/train/sunriseseto_izumo/pdf/jikokuhyo.pdf)
// as scripts/lib/pdf-lines.mjs reads it: the geometry the probe printed on
// 2026-10-19 — two tables side by side, a 列車番号 header row whose train
// numbers mark the columns, station names spaced out cell by cell with a
// trailing 発 / 着 / 〃, three- or four-digit times, and single-letter glyphs
// (a = blank, e = passes, g = not on this route, c = …) in every other cell.
// The times are the committed baseline's, the layout is the PDF's.

// [name cells, Seto time, Izumo time] per row, left table (from Tokyo).
const WEST = [
  [["東", "京", "発"], "2126", "2126"],
  [["横", "浜 〃"], "2152", "2152"],
  [["熱", "海 〃"], "2257", "2257"],
  [["沼", "津 〃"], "2316", "2316"],
  [["富", "士 〃"], "2332", "2332"],
  [["静", "岡 〃"], "2359", "2359"],
  [["浜", "松 〃"], "054", "054"],
  [["大", "阪", "着"], "e", "e"],
  [["三 ノ 宮 〃"], "e", "e"],
  [["姫", "路 〃"], "525", "525"],
  [["岡", "山", "〃"], "627", "627"],
  [["倉", "敷 〃"], "g", "646"],
  [["備中高梁 〃"], "g", "714"],
  [["新", "見 〃"], "g", "743"],
  [["米", "子", "〃"], "g", "905"],
  [["安", "来 〃"], "g", "916"],
  [["松", "江 〃"], "g", "933"],
  [["宍", "道 〃"], "g", "947"],
  [["出 雲 市", "着"], "g", "1000"],
  [["児", "島 着"], "652", "a"],
  [["坂", "出 〃"], "709", "a"],
  [["高", "松", "〃"], "727", "a"],
  [["多 度 津 〃"], "c", "a"],
  [["善 通 寺 〃"], "a", "a"],
  [["琴", "平", "着"], "a", "a"],
];

// Right table (to Tokyo).
const EAST = [
  [["琴", "平", "発"], "a", "a"],
  [["善 通 寺 〃"], "a", "a"],
  [["多 度 津 〃"], "a", "a"],
  [["高", "松", "〃"], "2126", "a"],
  [["坂", "出 〃"], "2144", "a"],
  [["児", "島 発"], "2201", "a"],
  [["出 雲 市", "発"], "g", "1857"],
  [["宍", "道 〃"], "g", "1911"],
  [["松", "江 〃"], "g", "1927"],
  [["安", "来 〃"], "g", "1944"],
  [["米", "子", "〃"], "g", "1954"],
  [["新", "見 〃"], "g", "2119"],
  [["備中高梁 〃"], "g", "2148"],
  [["倉", "敷 〃"], "g", "2214"],
  [["岡", "山", "〃"], "2234", "2234"],
  [["姫", "路 〃"], "2333", "2333"],
  [["三 ノ 宮 〃"], "011", "011"],
  [["大", "阪", "〃"], "033", "033"],
  [["浜", "松 着"], "e", "e"],
  [["静", "岡 〃"], "438", "438"],
  [["富", "士 〃"], "509", "509"],
  [["沼", "津 〃"], "525", "525"],
  [["熱", "海 〃"], "543", "543"],
  [["横", "浜 〃"], "644", "644"],
  [["東", "京", "着"], "708", "708"],
];

const nameCells = (names, x0) => names.map((text, i) => ({ x: x0 + [0, 17, 26][i], text }));
const filler = (from) => [0, 1, 2].map((i) => ({ x: from + i * 13, text: "a" }));

const rows = [];
for (let i = 0; i < Math.max(WEST.length, EAST.length); i++) {
  const cells = [];
  if (WEST[i]) {
    const [names, seto, izumo] = WEST[i];
    cells.push(...nameCells(names, 14), { x: 50 + (seto.length === 3 ? 2 : 0), text: seto }, ...filler(67));
    cells.push({ x: 101 + (izumo.length === 3 ? 3 : 0), text: izumo }, ...filler(118));
  }
  if (EAST[i]) {
    const [names, seto, izumo] = EAST[i];
    cells.push(...nameCells(names, 235), { x: 271 + (seto.length === 3 ? 3 : 0), text: seto }, ...filler(288));
    cells.push({ x: 322 + (izumo.length === 3 ? 3 : 0), text: izumo }, ...filler(339));
  }
  rows.push({ y: 175 + i * 6, cells: cells.sort((a, b) => a.x - b.x) });
}

export const JIKOKUHYO_LINES = [
  [
    { y: 23, cells: [{ x: 56, text: "〔サンライズ瀬戸〕・〔サンライズ出雲〕" }, { x: 268, text: "（東" }] },
    {
      y: 48,
      cells: [
        { x: 13, text: "列 車 番 号" },
        { x: 50, text: "5031M" },
        { x: 101, text: "5031M" },
        { x: 234, text: "列 車 番 号" },
        { x: 271, text: "5032M" },
        { x: 322, text: "5032M" },
      ],
    },
    // The Izumo column's own number, in a note under the header.
    { y: 80, cells: [{ x: 113, text: "4031M" }, { x: 335, text: "4032M" }] },
    { y: 169, cells: [{ x: 13, text: "発 車 番 線" }, { x: 235, text: "琴" }, { x: 252, text: "平" }, { x: 261, text: "発" }] },
    ...rows,
    { y: 328, cells: [{ x: 367, text: "!" }, { x: 373, text: "KOTSUSHIMBUNSHA" }] },
  ],
];
